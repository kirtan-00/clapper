"""Pydantic request/response models.

Only request bodies are strictly modelled. Responses are assembled dicts, because
the dashboard payloads are wide, nested and evolve fast; forcing them through
response models here would add ceremony without adding safety.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, EmailStr, Field


class LoginRequest(BaseModel):
    email: str
    password: str


class RegisterRequest(BaseModel):
    email: str
    name: str = Field(min_length=2, max_length=120)
    password: str = Field(min_length=8, max_length=200)
    role: Literal["viewer", "technician", "engineer", "manager"] = "viewer"
    skills: list[str] = Field(default_factory=list)
    phone: str | None = None
    shift: str = "A"


class CopilotRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    machine_id: int | None = None


class AlertActionRequest(BaseModel):
    note: str = Field(default="", max_length=1000)


class WorkOrderUpdateRequest(BaseModel):
    status: Literal[
        "pending_approval", "scheduled", "in_progress", "completed", "cancelled"
    ] | None = None
    assignee_id: int | None = None
    scheduled_start: float | None = None
    resolution_notes: str | None = Field(default=None, max_length=2000)
    actual_downtime_h: float | None = None
    actual_cost: float | None = None


class FeedbackRequest(BaseModel):
    ref_type: Literal["alert", "prediction", "work_order", "copilot"]
    ref_id: int
    verdict: Literal["useful", "false_positive", "missed", "wrong_action"]
    note: str = Field(default="", max_length=1000)


class InjectFaultRequest(BaseModel):
    machine_id: int
    category: Literal[
        "bearing_wear", "overheating", "lubrication_failure",
        "rotor_imbalance", "electrical_fault", "blockage_fouling",
    ]
    severity: float = Field(default=0.35, ge=0.0, le=1.0)
    progression: float = Field(default=0.004, ge=0.0, le=0.2)
    label: str | None = None


class SensorFaultRequest(BaseModel):
    sensor_id: int
    status: Literal["offline", "noisy", "stuck", "degraded"] = "offline"
    ticks: int = Field(default=120, ge=1, le=5000)
