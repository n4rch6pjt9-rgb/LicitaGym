FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN groupadd -g 1000 appgroup && \
    useradd -u 1000 -g appgroup -s /bin/bash -m appuser

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY --chown=appuser:appgroup coletor ./coletor

USER appuser

# Permite sobrescrever o comando facilmente no Cloud Run Job 
# (ex: python -m coletor.pncp_cloud_run ou python -m coletor.indexador)
ENTRYPOINT ["python", "-m"]
CMD ["coletor.pncp_cloud_run"]
