"""Step-service template. Build a FastAPI app with one ``async def run(input) -> output`` line."""

from .template import StepHandler, build_step_app

__all__ = ["StepHandler", "build_step_app"]
