FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py agent.py corpus.py BRIEF.md chainlit.md ./
# Cloud Run injects PORT; shell-form CMD so it expands.
CMD chainlit run app.py --host 0.0.0.0 --port ${PORT:-8080} --headless
