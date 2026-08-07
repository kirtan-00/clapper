"""Senchine AI — application entrypoint.

Startup sequence, in order and for a reason:

  1. Open the database and create the schema.
  2. Seed the fleet if the database is empty.
  3. Load or train the ML models (trained once, then cached to disk).
  4. Build the retrieval index.
  5. Load the simulator's runtime state from the persisted fleet.
  6. Prime one pipeline cycle so the dashboard has data on first paint.
  7. Start the real-time agent loop.

Step 6 matters more than it looks: a demo that opens on an empty dashboard and
asks you to wait has already lost the room.
"""

from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import db, seed
from .agents.orchestrator import orchestrator
from .config import settings
from .ml.registry import registry
from .rag.store import index
from .realtime import Client, hub
from .routers import auth, fleet, insights, workflow
from .security import user_from_token
from .sim.simulator import simulator

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s %(name)s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("senchine")

FRONTEND_DIR = Path(__file__).resolve().parents[2] / "frontend"


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("Senchine AI starting")

    # Bind the realtime hub to this event loop before anything can publish:
    # the agent pipeline runs on worker threads and marshals events back here.
    hub.bind_loop(asyncio.get_running_loop())

    db.connect()
    log.info("database ready at %s", settings.db_path)

    report = seed.seed_all()
    if report.get("skipped"):
        log.info("seed skipped — database already populated")
    else:
        log.info(
            "seeded %s machines across %s plants (%s sensors, %s documents) in %ss",
            report["machines"], report["plants"], report["sensors"],
            report["documents"], report["seconds"],
        )

    log.info("loading models…")
    await asyncio.to_thread(registry.load_or_train)
    metrics = registry.metrics()
    log.info(
        "models ready — classifier F1 %s, failure-type accuracy %s, RUL MAE %sh",
        metrics["predictor"].get("f1"),
        metrics["predictor"].get("category_accuracy"),
        metrics["predictor"].get("rul_mae_hours"),
    )

    stats = await asyncio.to_thread(index.build)
    log.info("retrieval index built — %s chunks", stats["chunks"])

    simulator.load_from_db()
    log.info(
        "simulator loaded — %s machines, %s sensors",
        len(simulator.machines), len(simulator.sensors),
    )

    # Prime the dashboard: enough cycles for a health history to exist.
    log.info("priming pipeline…")
    for _ in range(4):
        await asyncio.to_thread(orchestrator.run_cycle)

    await orchestrator.start()
    log.info(
        "pipeline running — tick %.1fs, heavy pass every %s ticks",
        settings.tick_seconds, settings.pipeline_every,
    )
    log.info("Senchine AI ready on http://%s:%s", settings.host, settings.port)

    yield

    log.info("shutting down")
    await orchestrator.stop()
    db.close()


app = FastAPI(
    title="Senchine AI",
    description=(
        "Multi-agent predictive-maintenance platform with EdgeSense retrofit "
        "sensor fusion for legacy machines."
    ),
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # demo posture; restrict to known origins in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(fleet.router)
app.include_router(workflow.router)
app.include_router(insights.router)


@app.get("/api/health")
def health() -> dict:
    """Liveness and readiness in one probe."""
    return {
        "status": "ok" if registry.ready and simulator.loaded else "starting",
        "models_ready": registry.ready,
        "simulator_loaded": simulator.loaded,
        "pipeline_running": orchestrator.running,
        "tick": orchestrator.tick,
        "llm_enabled": settings.llm_enabled,
        "version": app.version,
    }


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    """Live update channel.

    The browser cannot set an Authorization header on a WebSocket handshake, so
    the token arrives as a query parameter. It is still a real JWT check —
    unauthenticated sockets are closed with 1008 rather than admitted.
    """
    token = websocket.query_params.get("token")
    user = user_from_token(token)
    if user is None:
        await websocket.close(code=1008, reason="unauthorized")
        return

    await websocket.accept()
    client = Client(websocket, user)
    client.topics.add(f"user:{user['id']}")
    await hub.register(client)

    # Replay recent activity so a reconnecting tab is immediately populated.
    try:
        await websocket.send_text(
            json.dumps({
                "topic": "direct", "event": "connected",
                "data": {
                    "user": user["name"],
                    "topics": sorted(client.topics),
                    "replay": list(hub.recent)[-20:],
                },
            })
        )
    except (WebSocketDisconnect, RuntimeError):
        await hub.unregister(client)
        return

    async def pump() -> None:
        """Drain this client's queue onto the socket."""
        while True:
            message = await client.queue.get()
            await websocket.send_text(json.dumps(message, default=str))

    pump_task = asyncio.create_task(pump())
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                continue

            action = message.get("action")
            if action == "subscribe":
                topic = str(message.get("topic", ""))[:64]
                if topic:
                    client.topics.add(topic)
            elif action == "unsubscribe":
                client.topics.discard(str(message.get("topic", ""))[:64])
            elif action == "ping":
                await hub.send_direct(client, "pong", {"ts": message.get("ts")})
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # noqa: BLE001 — never let one socket take down the app
        log.debug("websocket error: %s", exc)
    finally:
        pump_task.cancel()
        await hub.unregister(client)


# --- static frontend -------------------------------------------------------

if FRONTEND_DIR.exists():
    app.mount(
        "/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static"
    )

    @app.get("/")
    def serve_index() -> FileResponse:
        return FileResponse(str(FRONTEND_DIR / "index.html"))

    @app.exception_handler(404)
    async def spa_fallback(request, exc):  # noqa: ANN001
        """Serve the SPA shell for client-side routes, but never for the API."""
        if request.url.path.startswith(("/api", "/ws", "/static")):
            return JSONResponse({"detail": "not found"}, status_code=404)
        return FileResponse(str(FRONTEND_DIR / "index.html"))


def run() -> None:
    import uvicorn

    uvicorn.run(
        "backend.app.main:app",
        host=settings.host,
        port=settings.port,
        reload=False,
        log_level="info",
    )


if __name__ == "__main__":
    run()
