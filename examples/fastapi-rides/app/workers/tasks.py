import stripe
from celery import shared_task
from app.models import Payment

@shared_task(queue="notifications")
def notify_driver(driver_id, ride_id):
    import httpx
    httpx.post("https://fcm.googleapis.com/fcm/send", json={"to": driver_id})

@shared_task(queue="payments")
def charge_rider(ride_id):
    intent = stripe.PaymentIntent.create(amount=1200, currency="usd")
    session.add(Payment(ride_id=ride_id, intent=intent.id))
