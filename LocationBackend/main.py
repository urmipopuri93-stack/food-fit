
import os
import asyncio
import time

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

app = FastAPI(title="FoodFit Location API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:5174",
    ],
    allow_methods=["POST", "GET"],
    allow_headers=["Content-Type"],
)

class AddressRequest(BaseModel):
    address: str = Field(min_length=3, max_length=300)

_cache = {}
_geocode_lock = asyncio.Lock()
_last_request = 0.0

@app.get("/health")
async def health():
    return {"status": "ok"}

@app.post("/api/geocode")
async def geocode(request: AddressRequest):
    global _last_request

    address = request.address.strip()
    cache_key = address.lower()

    if cache_key in _cache:
        return _cache[cache_key]

    contact_email = os.environ.get("GEOCODER_CONTACT_EMAIL")
    if not contact_email:
        raise HTTPException(
            status_code=503,
            detail="Configure GEOCODER_CONTACT_EMAIL on the server.",
        )

    async with _geocode_lock:
        if cache_key in _cache:
            return _cache[cache_key]

        # Respect the public geocoder's 1-request-per-second limit.
        elapsed = time.monotonic() - _last_request
        if elapsed < 1:
            await asyncio.sleep(1 - elapsed)

        headers = {
            "User-Agent": f"FoodFitDatathon/1.0 ({contact_email})"
        }

        try:
            async with httpx.AsyncClient(timeout=15) as client:
                _last_request = time.monotonic()
                response = await client.get(
                    "https://nominatim.openstreetmap.org/search",
                    params={
                        "q": address,
                        "format": "json",
                        "limit": 1,
                        "countrycodes": "us",
                    },
                    headers=headers,
                )
                response.raise_for_status()
                results = response.json()

        except httpx.HTTPError:
            raise HTTPException(
                status_code=502,
                detail="Address lookup service unavailable.",
            )

        if not results:
            raise HTTPException(
                status_code=404,
                detail="Address not found. Try a complete address or city and state.",
            )

        result = {
            "lat": float(results[0]["lat"]),
            "lng": float(results[0]["lon"]),
            "label": results[0]["display_name"],
        }

        _cache[cache_key] = result
        return result
