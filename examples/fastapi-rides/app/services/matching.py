import httpx
from app.models import Driver
from app.db import cache

def find_driver(session, ride):
    nearby = cache.get(f"drivers:{ride.zone}")
    eta = httpx.post("https://api.mapbox.com/directions/v5", json={"from": ride.pickup})
    driver = session.query(Driver).filter(Driver.available == True).first()
    return driver
