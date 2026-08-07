"""WebSocket fan-out hub for live dashboard updates.

Topic-based rather than broadcast-everything: a browser watching one machine
should not receive telemetry for the other twenty-nine. Clients subscribe to
topics (`fleet`, `machine:12`, `alerts`, `agents`) and the hub delivers only
what they asked for.

Slow or dead sockets are dropped rather than allowed to block the agent
pipeline — the real-time path must never be held up by a browser tab that went
to sleep.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections import deque
from typing import Any

from fastapi import WebSocket

MAX_QUEUE = 64


class Client:
    def __init__(self, socket: WebSocket, user: dict[str, Any]) -> None:
        self.socket = socket
        self.user = user
        self.topics: set[str] = {"fleet", "alerts", "agents"}
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=MAX_QUEUE)
        self.connected_at = time.time()
        self.dropped = 0


class Hub:
    def __init__(self) -> None:
        self.clients: set[Client] = set()
        self._lock = asyncio.Lock()
        # Small replay buffer so a page refresh shows activity immediately
        # instead of an empty dashboard waiting for the next tick.
        self.recent: deque[dict[str, Any]] = deque(maxlen=60)
        # The agent pipeline runs on a worker thread, so publishes originate off
        # the event loop. We capture the loop at startup and marshal onto it —
        # `asyncio.get_running_loop()` raises on a worker thread, which would
        # silently drop every realtime event.
        self._loop: asyncio.AbstractEventLoop | None = None
        self.dropped_no_loop = 0

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    async def register(self, client: Client) -> None:
        async with self._lock:
            self.clients.add(client)

    async def unregister(self, client: Client) -> None:
        async with self._lock:
            self.clients.discard(client)

    async def publish(self, topic: str, event: str, payload: Any) -> None:
        message = {
            "topic": topic,
            "event": event,
            "ts": time.time(),
            "data": payload,
        }
        if topic in ("alerts", "agents", "workorders"):
            self.recent.append(message)

        async with self._lock:
            targets = [c for c in self.clients if topic in c.topics]

        for client in targets:
            try:
                client.queue.put_nowait(message)
            except asyncio.QueueFull:
                # Back-pressure: drop the oldest frame rather than the newest, so
                # a lagging client still converges on current state.
                client.dropped += 1
                try:
                    client.queue.get_nowait()
                    client.queue.put_nowait(message)
                except (asyncio.QueueEmpty, asyncio.QueueFull):
                    pass

    def publish_soon(self, topic: str, event: str, payload: Any) -> None:
        """Fire-and-forget publish from synchronous code, on any thread."""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None

        if loop is not None:
            # Already on the event loop.
            loop.create_task(self.publish(topic, event, payload))
            return

        if self._loop is None or self._loop.is_closed():
            self.dropped_no_loop += 1
            return

        # Called from a worker thread — hand the coroutine to the bound loop.
        try:
            asyncio.run_coroutine_threadsafe(
                self.publish(topic, event, payload), self._loop
            )
        except RuntimeError:
            self.dropped_no_loop += 1

    async def send_direct(self, client: Client, event: str, payload: Any) -> None:
        await client.socket.send_text(
            json.dumps({"topic": "direct", "event": event, "ts": time.time(), "data": payload})
        )

    def stats(self) -> dict[str, Any]:
        return {
            "clients": len(self.clients),
            "topics": sorted({t for c in self.clients for t in c.topics}),
            "dropped_frames": sum(c.dropped for c in self.clients),
        }


hub = Hub()
