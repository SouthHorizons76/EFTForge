"""Validate the bounded Explore request before occupying a solver slot."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from optimizer.solver import OptimizeParams


class ExploreRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    weapon_id: str = Field(min_length=1, max_length=100)
    tradeoff: Literal["price", "recoil", "ergo"] = "price"
    steps: int = Field(default=20, ge=10, le=81)
    max_price: float | None = Field(default=None, ge=0)
    min_ergonomics: float | None = Field(default=None, ge=0)
    max_recoil_v: float | None = Field(default=None, ge=0)
    max_weight: float | None = Field(default=None, ge=0)
    min_mag_capacity: int | None = Field(default=None, ge=0)
    min_sighting_range: int | None = Field(default=None, ge=0)
    max_moa: float | None = Field(default=None, ge=0)
    prevent_overswing: bool = False
    require_suppressor: bool = False
    include_items: list[str] | None = Field(default=None, max_length=300)
    exclude_items: list[str] | None = Field(default=None, max_length=300)
    flea_available: bool = True
    trader_levels: dict[str, int] | None = None
    player_level: int | None = Field(default=None, ge=0, le=79)
    strength_level: int = Field(default=10, ge=0, le=51)
    equip_ergo_modifier: float = Field(default=0, ge=-1, le=1)
    assume_full_mag: bool = True
    selected_ammo_id: str | None = None
    selected_ubgl_ammo_id: str | None = None

    def optimize_params(self):
        return OptimizeParams(**self.model_dump(exclude={"weapon_id", "tradeoff", "steps"}))
