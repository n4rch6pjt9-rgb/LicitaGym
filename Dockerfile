FROM python:3.12-slim
WORKDIR /app
COPY services/coletor-externo/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY services/coletor-externo/coletor ./coletor
ENTRYPOINT ["python", "-m", "coletor.main"]
