# Food Fit backend (FastAPI)

    python -m venv .venv
    .venv\Scripts\activate          # Mac/Linux: source .venv/bin/activate
    pip install -r requirements.txt
    uvicorn app.main:app --reload

Docs and a test UI: http://localhost:8000/docs
Data is stored in foodfit.db (SQLite), created on first run.
