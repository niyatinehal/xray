from fastapi import FastAPI
from app.routers import rides, payments
app = FastAPI()
app.include_router(rides.router)
app.include_router(payments.router)
