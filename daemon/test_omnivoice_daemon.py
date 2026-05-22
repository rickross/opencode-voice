import asyncio
import importlib.util
import sys
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("omnivoice-daemon.py")
SPEC = importlib.util.spec_from_file_location("omnivoice_daemon", MODULE_PATH)
daemon = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules["omnivoice_daemon"] = daemon
SPEC.loader.exec_module(daemon)


class OmniVoiceDaemonTests(unittest.TestCase):
    def test_parse_cells_accepts_multi_voice_cells(self):
        with self.subTest("multi voice"):
            import tempfile

            with tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                aurora = root / "aurora.voiceclone.pt"
                solene = root / "solene.voiceclone.pt"
                aurora.write_bytes(b"aurora")
                solene.write_bytes(b"solene")

                cells = daemon.parse_cells(
                    f"aurora={aurora},solene={solene}",
                    Path(""),
                    "aurora",
                )

                self.assertEqual(cells, {"aurora": aurora, "solene": solene})

    def test_parse_cells_rejects_missing_default_voice(self):
        import tempfile

        with tempfile.TemporaryDirectory() as temp_dir:
            aurora = Path(temp_dir) / "aurora.voiceclone.pt"
            aurora.write_bytes(b"aurora")

            with self.assertRaisesRegex(ValueError, "Default voice 'solene'"):
                daemon.parse_cells(f"aurora={aurora}", Path(""), "solene")

    def test_parse_cells_rejects_duplicate_voice_key(self):
        import tempfile

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            first = root / "first.voiceclone.pt"
            second = root / "second.voiceclone.pt"
            first.write_bytes(b"first")
            second.write_bytes(b"second")

            with self.assertRaisesRegex(ValueError, "Duplicate voice key"):
                daemon.parse_cells(f"aurora={first},aurora={second}", Path(""), "aurora")

    def test_parse_cells_uses_legacy_cell_with_default_voice(self):
        import tempfile

        with tempfile.TemporaryDirectory() as temp_dir:
            cell = Path(temp_dir) / "lison.voiceclone.pt"
            cell.write_bytes(b"cell")

            self.assertEqual(daemon.parse_cells("", cell, "solene"), {"solene": cell})

    def test_speak_request_rejects_invalid_priority(self):
        with self.assertRaises(Exception):
            daemon.SpeakRequest(text="hello", priority="urgent")

    def test_priority_queue_processes_high_before_later_normal(self):
        async def run_queue():
            queue = asyncio.PriorityQueue()
            loop = asyncio.get_running_loop()
            normal = daemon.SpeakJob(
                priority_rank=1,
                sequence=1,
                request=daemon.SpeakRequest(text="normal"),
                voice="aurora",
                future=loop.create_future(),
            )
            high = daemon.SpeakJob(
                priority_rank=0,
                sequence=2,
                request=daemon.SpeakRequest(text="high", priority="high"),
                voice="solene",
                future=loop.create_future(),
            )
            await queue.put(normal)
            await queue.put(high)
            return (await queue.get()).request.text, (await queue.get()).request.text

        self.assertEqual(asyncio.run(run_queue()), ("high", "normal"))

    def test_priority_queue_preserves_fifo_within_priority(self):
        async def run_queue():
            queue = asyncio.PriorityQueue()
            loop = asyncio.get_running_loop()
            first = daemon.SpeakJob(
                priority_rank=1,
                sequence=1,
                request=daemon.SpeakRequest(text="first"),
                voice="aurora",
                future=loop.create_future(),
            )
            second = daemon.SpeakJob(
                priority_rank=1,
                sequence=2,
                request=daemon.SpeakRequest(text="second"),
                voice="aurora",
                future=loop.create_future(),
            )
            await queue.put(second)
            await queue.put(first)
            return (await queue.get()).request.text, (await queue.get()).request.text

        self.assertEqual(asyncio.run(run_queue()), ("first", "second"))

    def test_health_payload_exposes_multi_voice_queue_state(self):
        state = daemon.DaemonState()
        state.model = object()
        state.voice_clone_prompts = {"aurora": object(), "solene": object()}
        state.cell_paths = {
            "aurora": Path("/tmp/aurora.voiceclone.pt"),
            "solene": Path("/tmp/solene.voiceclone.pt"),
        }
        state.default_voice = "aurora"
        state.current_job = {"voice": "solene", "agent": "solene"}

        payload = state.health_payload()

        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["voices"], ["aurora", "solene"])
        self.assertEqual(payload["default_voice"], "aurora")
        self.assertEqual(payload["cell_paths"]["aurora"], "/tmp/aurora.voiceclone.pt")
        self.assertEqual(payload["queue_depth"], 0)
        self.assertEqual(payload["current_job"], {"voice": "solene", "agent": "solene"})
        self.assertEqual(payload["waiters"], 1)


if __name__ == "__main__":
    unittest.main()
