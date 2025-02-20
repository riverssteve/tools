#!/usr/bin/env -S uv run --script
# /// script
# dependencies = [
#   "fastapi[standard]",
#   "uvicorn"
# ]
# ///
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path
import logging

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize FastAPI app
app = FastAPI(
    title="HTML File Server",
    description="A simple FastAPI application to serve HTML files",
    version="1.0.0",
)

# Get the current directory
current_dir = Path(__file__).parent

# Mount the current directory as a static files directory
app.mount("/static", StaticFiles(directory=str(current_dir)), name="static")


@app.get("/", response_class=HTMLResponse)
async def read_html() -> HTMLResponse:
    """
    Serve the index.html file from the current directory
    """
    try:
        html_file = current_dir / "index.html"

        if not html_file.exists():
            logger.error(f"File not found: {html_file}")
            raise HTTPException(status_code=404, detail="HTML file not found")

        with open(html_file, "r", encoding="utf-8") as f:
            content = f.read()

        return HTMLResponse(content=content)

    except Exception as e:
        logger.error(f"Error serving HTML file: {str(e)}")
        raise HTTPException(status_code=500, detail="Internal server error")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
