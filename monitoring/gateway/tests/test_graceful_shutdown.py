#!/usr/bin/env python3

from __future__ import annotations

import http.client
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from monitoring.gateway.server import (
    GRACEFUL_SHUTDOWN_SECONDS,
    _DrainableThreadingHTTPServer,
    _IPv6DrainableThreadingHTTPServer,
    _serve_with_graceful_shutdown,
    _threading_server,
)


ROOT = Path(__file__).resolve().parents[3]


def _wait_for_path(path: Path, *, timeout: float = 4.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if path.exists():
            return
        time.sleep(0.01)
    raise AssertionError(f"timed out waiting for {path.name}")


def _worker_main(mode: str, grace_seconds: float, state_dir: Path) -> int:
    ready_path = state_dir / "ready"
    entered_path = state_dir / "entered"
    release_path = state_dir / "release"
    completed_path = state_dir / "completed"
    result_path = state_dir / "result.json"

    class WorkerHandler(BaseHTTPRequestHandler):
        def log_message(self, _format: str, *_args: object) -> None:
            return

        def do_GET(self) -> None:
            active = self.server.active_request_count  # type: ignore[attr-defined]
            entered_path.write_text(str(active), encoding="utf-8")
            if mode == "error":
                try:
                    raise RuntimeError("synthetic handler failure")
                finally:
                    completed_path.touch()
            if mode == "disconnect":
                try:
                    time.sleep(0.1)
                    body = b"x" * (4 * 1024 * 1024)
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    for offset in range(0, len(body), 64 * 1024):
                        self.wfile.write(body[offset : offset + 64 * 1024])
                        self.wfile.flush()
                finally:
                    completed_path.touch()
                return
            if mode == "block":
                while not release_path.exists():
                    time.sleep(0.01)
            body = b"complete"
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            completed_path.touch()

    server = _threading_server("127.0.0.1", 0, WorkerHandler)
    # Synthetic handler failures are expected by one lifecycle test and must
    # not pollute the worker output with an unrelated socketserver traceback.
    server.handle_error = lambda _request, _client_address: None  # type: ignore[method-assign]
    close_count = 0
    original_server_close = server.server_close

    def tracked_server_close() -> None:
        nonlocal close_count
        close_count += 1
        original_server_close()

    server.server_close = tracked_server_close  # type: ignore[method-assign]
    started = threading.Event()

    def publish_ready() -> None:
        if started.wait(timeout=3.0):
            ready_path.write_text(str(server.server_address[1]), encoding="utf-8")

    threading.Thread(target=publish_ready, daemon=True).start()
    exit_code = _serve_with_graceful_shutdown(
        server,
        grace_seconds=grace_seconds,
        started_event=started,
    )
    result_path.write_text(
        json.dumps(
            {
                "activeRequests": server.active_request_count,
                "closeCount": close_count,
                "exitCode": exit_code,
                "shutdownStarts": server.shutdown_start_count,
            },
            sort_keys=True,
        ),
        encoding="utf-8",
    )
    return exit_code


class _Worker:
    def __init__(self, mode: str, *, grace_seconds: float = 1.5) -> None:
        self._temporary_directory = tempfile.TemporaryDirectory()
        self.state_dir = Path(self._temporary_directory.name)
        self.ready_path = self.state_dir / "ready"
        self.entered_path = self.state_dir / "entered"
        self.release_path = self.state_dir / "release"
        self.completed_path = self.state_dir / "completed"
        self.result_path = self.state_dir / "result.json"
        self.process = subprocess.Popen(
            (
                sys.executable,
                "-m",
                "monitoring.gateway.tests.test_graceful_shutdown",
                "--worker",
                mode,
                str(grace_seconds),
                str(self.state_dir),
            ),
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            _wait_for_path(self.ready_path)
            self.port = int(self.ready_path.read_text(encoding="utf-8"))
        except BaseException:
            self.close()
            raise

    def __enter__(self) -> _Worker:
        return self

    def __exit__(self, _type: object, _value: object, _traceback: object) -> None:
        self.close()

    def send_signal(self, configured_signal: signal.Signals) -> None:
        os.kill(self.process.pid, configured_signal)

    def finish(
        self,
        *,
        timeout: float = 4.0,
    ) -> tuple[int, dict[str, int], str, str]:
        stdout, stderr = self.process.communicate(timeout=timeout)
        if not self.result_path.exists():
            raise AssertionError(
                f"worker produced no result (exit={self.process.returncode}, stderr={stderr})"
            )
        result = json.loads(self.result_path.read_text(encoding="utf-8"))
        return self.process.returncode, result, stdout, stderr

    def close(self) -> None:
        if self.process.poll() is None:
            self.process.kill()
            self.process.communicate(timeout=2)
        self._temporary_directory.cleanup()


class GracefulShutdownTests(unittest.TestCase):
    def _assert_listener_closed(self, port: int) -> None:
        with self.assertRaises(OSError):
            socket.create_connection(("127.0.0.1", port), timeout=0.2)

    def _request_in_thread(
        self,
        port: int,
        results: dict[str, object],
    ) -> threading.Thread:
        def request() -> None:
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
            try:
                connection.request("GET", "/block")
                response = connection.getresponse()
                results["status"] = response.status
                results["body"] = response.read()
            except BaseException as exc:
                results["error"] = exc
            finally:
                connection.close()

        thread = threading.Thread(target=request, daemon=True)
        thread.start()
        return thread

    def test_production_default_and_ipv4_ipv6_servers_share_lifecycle(self) -> None:
        self.assertEqual(GRACEFUL_SHUTDOWN_SECONDS, 15.0)
        self.assertTrue(_DrainableThreadingHTTPServer.daemon_threads)
        self.assertTrue(
            issubclass(
                _IPv6DrainableThreadingHTTPServer,
                _DrainableThreadingHTTPServer,
            )
        )

    def test_worker_registration_rolls_back_when_thread_start_fails(self) -> None:
        server = _threading_server("127.0.0.1", 0, BaseHTTPRequestHandler)
        try:
            with patch.object(
                ThreadingHTTPServer,
                "process_request",
                side_effect=RuntimeError("thread start failed"),
            ):
                with self.assertRaisesRegex(RuntimeError, "thread start failed"):
                    server.process_request(object(), ("127.0.0.1", 1))
            self.assertEqual(server.active_request_count, 0)
        finally:
            server.server_close()

    def test_new_socket_is_closed_without_worker_after_drain_begins(self) -> None:
        server = _threading_server("127.0.0.1", 0, BaseHTTPRequestHandler)
        client_socket, accepted_socket = socket.socketpair()
        client_socket.settimeout(1)
        try:
            self.assertTrue(server.begin_drain())
            server.process_request(accepted_socket, ("127.0.0.1", 1))
            self.assertEqual(server.active_request_count, 0)
            self.assertEqual(client_socket.recv(1), b"")
        finally:
            client_socket.close()
            accepted_socket.close()
            server.server_close()

    def test_idle_sigterm_and_sigint_exit_cleanly(self) -> None:
        for configured_signal in (signal.SIGTERM, signal.SIGINT):
            with self.subTest(configured_signal=configured_signal):
                with _Worker("idle") as worker:
                    worker.send_signal(configured_signal)
                    returncode, result, stdout, stderr = worker.finish()
                    self.assertEqual(returncode, 0)
                    self.assertEqual(result["exitCode"], 0)
                    self.assertEqual(result["activeRequests"], 0)
                    self.assertEqual(result["shutdownStarts"], 1)
                    self.assertEqual(result["closeCount"], 1)
                    self.assertNotIn("Traceback", stdout + stderr)
                    self._assert_listener_closed(worker.port)

    def test_in_flight_request_completes_before_clean_exit(self) -> None:
        with _Worker("block") as worker:
            results: dict[str, object] = {}
            request_thread = self._request_in_thread(worker.port, results)
            _wait_for_path(worker.entered_path)
            self.assertGreaterEqual(
                int(worker.entered_path.read_text(encoding="utf-8")),
                1,
            )
            worker.send_signal(signal.SIGTERM)
            time.sleep(0.1)
            self.assertIsNone(worker.process.poll())
            worker.release_path.touch()
            request_thread.join(timeout=3)
            returncode, result, stdout, stderr = worker.finish()
            self.assertEqual(results, {"status": 200, "body": b"complete"})
            self.assertEqual(returncode, 0)
            self.assertEqual(result["activeRequests"], 0)
            self.assertEqual(result["shutdownStarts"], 1)
            self.assertEqual(result["closeCount"], 1)
            self.assertNotIn("Traceback", stdout + stderr)

    def test_timeout_is_bounded_nonzero_and_cannot_hang_on_worker(self) -> None:
        with _Worker("block", grace_seconds=0.2) as worker:
            results: dict[str, object] = {}
            request_thread = self._request_in_thread(worker.port, results)
            _wait_for_path(worker.entered_path)
            started = time.monotonic()
            worker.send_signal(signal.SIGTERM)
            returncode, result, stdout, stderr = worker.finish(timeout=2)
            elapsed = time.monotonic() - started
            request_thread.join(timeout=1)
            self.assertEqual(returncode, 1)
            self.assertEqual(result["exitCode"], 1)
            self.assertEqual(result["activeRequests"], 1)
            self.assertEqual(result["shutdownStarts"], 1)
            self.assertEqual(result["closeCount"], 1)
            self.assertLess(elapsed, 1.5)
            self.assertNotIn("Traceback", stdout + stderr)
            self._assert_listener_closed(worker.port)

    def test_repeated_sigterm_starts_and_closes_only_once(self) -> None:
        with _Worker("block") as worker:
            results: dict[str, object] = {}
            request_thread = self._request_in_thread(worker.port, results)
            _wait_for_path(worker.entered_path)
            worker.send_signal(signal.SIGTERM)
            time.sleep(0.05)
            worker.send_signal(signal.SIGTERM)
            worker.release_path.touch()
            request_thread.join(timeout=3)
            returncode, result, stdout, stderr = worker.finish()
            self.assertEqual(returncode, 0)
            self.assertEqual(result["shutdownStarts"], 1)
            self.assertEqual(result["closeCount"], 1)
            self.assertNotIn("Traceback", stdout + stderr)

    def test_handler_error_and_client_disconnect_decrement_active_count(self) -> None:
        with _Worker("error") as worker:
            connection = http.client.HTTPConnection(
                "127.0.0.1", worker.port, timeout=2
            )
            with self.assertRaises(http.client.RemoteDisconnected):
                connection.request("GET", "/error")
                connection.getresponse()
            connection.close()
            _wait_for_path(worker.completed_path)
            worker.send_signal(signal.SIGTERM)
            returncode, result, stdout, stderr = worker.finish()
            self.assertEqual(returncode, 0)
            self.assertEqual(result["activeRequests"], 0)
            self.assertNotIn("Traceback", stdout + stderr)

        with _Worker("disconnect") as worker:
            connection = socket.create_connection(
                ("127.0.0.1", worker.port), timeout=2
            )
            connection.sendall(b"GET /disconnect HTTP/1.0\r\nHost: localhost\r\n\r\n")
            _wait_for_path(worker.entered_path)
            connection.close()
            _wait_for_path(worker.completed_path)
            worker.send_signal(signal.SIGTERM)
            returncode, result, stdout, stderr = worker.finish()
            self.assertEqual(returncode, 0)
            self.assertEqual(result["activeRequests"], 0)
            self.assertNotIn("Traceback", stdout + stderr)


if __name__ == "__main__":
    if len(sys.argv) == 5 and sys.argv[1] == "--worker":
        raise SystemExit(
            _worker_main(
                sys.argv[2],
                float(sys.argv[3]),
                Path(sys.argv[4]),
            )
        )
    unittest.main()
