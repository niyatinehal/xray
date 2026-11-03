from fastapi import APIRouter, Depends
from app.models import Ride
from app.services.matching import find_driver
from app.workers.tasks import notify_driver

router = APIRouter(prefix="/rides")

@router.post("/")
def request_ride(body: RideIn, session = Depends(get_session)):
    ride = Ride(**body.dict())
    session.add(ride)
    session.commit()
    driver = find_driver(session, ride)
    notify_driver.delay(driver.id, ride.id)
    return ride

@router.post("/{ride_id}/complete")
def complete_ride(ride_id: int, session = Depends(get_session)):
    ride = session.get(Ride, ride_id)
    from app.workers.tasks import charge_rider
    charge_rider.apply_async(args=[ride_id], countdown=30)
    return ride
