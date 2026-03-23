import os
import subprocess
import time
import sys

DB_FILE = "tarkov.db"


def delete_db():
    if os.path.exists(DB_FILE):
        print("Deleting old database...")
        os.remove(DB_FILE)
    else:
        print("No existing database found.")


def sync_tarkov():
    print("Syncing tarkov.dev data...")
    subprocess.run([sys.executable, "sync_tarkov_dev.py"], check=True)


def seed_other():
    # Add any additional seed scripts here
    # subprocess.run(["python", "other_seed_script.py"], check=True)
    print("No additional seeds configured.")


def start_server_dev():
    print("Starting server (dev mode with --reload)...")
    subprocess.run(["uvicorn", "main:app", "--reload"])


def start_server_prod():
    """Production server: no --reload, multi-worker via Gunicorn + Uvicorn workers."""
    print("Starting server (production)...")
    workers = str(os.cpu_count() or 2)
    subprocess.run([
        "gunicorn", "main:app",
        "-w", workers,
        "-k", "uvicorn.workers.UvicornWorker",
        "--bind", "0.0.0.0:8000",
    ])


if __name__ == "__main__":
    prod = "--prod" in sys.argv
    delete_db()
    sync_tarkov()
    seed_other()
    if prod:
        start_server_prod()
    else:
        start_server_dev()
