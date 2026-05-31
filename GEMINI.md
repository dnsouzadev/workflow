# Workflow Studio - Gemini Context

This project is a DAG-based workflow execution platform called **Workflow Studio**. It allows users to design, save, and execute workflows consisting of interconnected nodes (Input, Filter, Output).

## Project Overview

-   **Backend:** Python 3.14+ with FastAPI, Redis Queue (RQ) for asynchronous job execution, and SQLite for persistent storage of runs and workflows.
-   **Frontend:** React 19 with TypeScript, using D3.js for the interactive graph editor.
-   **Architecture:**
    -   **API:** FastAPI handles workflow management (CRUD) and execution requests.
    -   **Execution:** Workflows are executed as background jobs using RQ.
    -   **Persistence:** SQLite (`runs.db`) stores workflow definitions, execution runs, and individual node attempt details.
    -   **Real-time Updates:** WebSockets and Redis Pub/Sub provide live feedback of execution progress to the frontend.
    -   **Orchestration:** Docker Compose manages the Redis, Backend, Worker, and Frontend services.

## Directory Structure

-   `backend/`: FastAPI application and execution engine.
    -   `app/main.py`: API entry point and WebSocket handlers.
    -   `app/worker.py`: RQ worker entry point.
    -   `app/engine.py`: Core logic for executing the DAG.
    -   `app/storage.py`: SQLite abstraction for runs and workflows.
    -   `app/jobs.py`: RQ job wrapper for workflow execution.
-   `frontend/`: React application.
    -   `src/App.tsx`: Main application component and state management.
    -   `src/components/Graph.tsx`: D3-based graph visualization and interaction.
    -   `src/workflow.ts`: Types and initial workflow data.
-   `docker-compose.yml`: Local development environment configuration.

## Building and Running

### Using Docker Compose (Recommended)

To start the entire stack:

```bash
docker-compose up --build
```

-   **Frontend:** [http://localhost:3000](http://localhost:3000)
-   **Backend API:** [http://localhost:8000](http://localhost:8000)
-   **API Docs:** [http://localhost:8000/docs](http://localhost:8000/docs)

### Manual Setup (Development)

#### Backend
1.  Create a virtual environment: `python -m venv venv`
2.  Activate it: `source venv/bin/activate`
3.  Install dependencies: `pip install -r backend/requirements.txt`
4.  Run Redis locally (required).
5.  Start the API: `uvicorn backend.app.main:app --reload`
6.  Start a worker: `python backend/app/worker.py`

#### Frontend
1.  Install dependencies: `npm install` (in `frontend/`)
2.  Start the development server: `npm start`

## Development Conventions

-   **Backend:**
    -   Follows standard FastAPI patterns.
    -   Uses `pydantic` for data validation.
    -   Logging is centralized in `logging_config.py`.
    -   Metrics are available at `/metrics` in Prometheus format.
-   **Frontend:**
    -   Uses Functional Components with Hooks.
    -   TypeScript for type safety.
    -   D3.js for the graph canvas (complex interactions).
    -   CSS is kept in `App.css` and `index.css`.
-   **Workflow Schema:**
    -   Workflows are JSON objects with `nodes` (id, type, x, y) and `edges` (from, to).
    -   Cycles are prohibited (DAG).
-   **Persistence:**
    -   Runs are stored in SQLite. Do not delete `runs.db` if you want to keep history.
    -   The DB path is configurable via `RUNS_DB_PATH`.
