"""OpenTelemetry: one span per API call with the end user's identity, plus usage metrics.

Exported over OTLP when an endpoint is configured (OTEL_EXPORTER_OTLP_ENDPOINT, or the endpoint Databricks Apps
provides when app telemetry is on); otherwise a no-op. The same events are always written to Lakebase
(modules/usage), so per-user analytics work with or without a collector.
"""
from __future__ import annotations

import logging
import os
from typing import Any

from core import config

log = logging.getLogger("dis.otel")
tracer: Any = None
meters: dict[str, Any] = {}
enabled = False


def init() -> bool:
    global tracer, enabled
    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT") or os.environ.get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")
    if not endpoint or config.OFFLINE:
        return False
    try:
        from opentelemetry import metrics, trace
        from opentelemetry.sdk.metrics import MeterProvider
        from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor

        grpc = os.environ.get("OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf").startswith("grpc")
        if grpc:
            from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import OTLPMetricExporter
            from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
        else:
            from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
            from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        res = Resource.create({"service.name": config.OTEL_SERVICE_NAME, "service.version": config.VERSION,
                               "databricks.app.name": config.APP_NAME, "deployment.environment": os.environ.get("DIS_ENV", "demo")})
        tp = TracerProvider(resource=res)
        tp.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
        trace.set_tracer_provider(tp)
        mp = MeterProvider(resource=res, metric_readers=[PeriodicExportingMetricReader(OTLPMetricExporter(), export_interval_millis=30000)])
        metrics.set_meter_provider(mp)
        tracer = trace.get_tracer("dis.api")
        m = metrics.get_meter("dis.usage")
        meters["calls"] = m.create_counter("dis.api.calls", description="API calls by user, route and status")
        meters["duration"] = m.create_histogram("dis.api.duration", unit="ms", description="API latency")
        meters["logins"] = m.create_counter("dis.user.logins", description="User sessions (first call after 30 min idle)")
        meters["actions"] = m.create_counter("dis.user.actions", description="Governed actions (create, submit, approve, deploy, ...)")
        enabled = True
        log.info("OpenTelemetry export on (%s, %s)", endpoint, "grpc" if grpc else "http")
    except Exception as e:  # noqa: BLE001 - telemetry must never break the app
        log.warning("OpenTelemetry not started: %s", e)
        enabled = False
    return enabled


def span(name: str, attrs: dict[str, Any]):
    if tracer is None:
        from contextlib import nullcontext
        return nullcontext()
    return tracer.start_as_current_span(name, attributes={k: v for k, v in attrs.items() if v is not None})


def count(metric: str, value: float, attrs: dict[str, Any]) -> None:
    m = meters.get(metric)
    if m is None:
        return
    try:
        (m.record if metric == "duration" else m.add)(value, attributes={k: str(v) for k, v in attrs.items() if v is not None})
    except Exception:  # noqa: BLE001
        pass


def trace_id() -> str | None:
    if tracer is None:
        return None
    from opentelemetry import trace
    ctx = trace.get_current_span().get_span_context()
    return format(ctx.trace_id, "032x") if ctx and ctx.trace_id else None
