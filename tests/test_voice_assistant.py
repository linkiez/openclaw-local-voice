import json
import unittest
from unittest.mock import Mock, patch

import numpy as np

from voice_assistant import (
    ask_openclaw,
    gateway_call,
    handle_wake,
    is_direct_english_wake,
    is_english_wake_candidate,
    is_portuguese_wake_confirmation,
    prepare_audio,
    audio_to_pcm16,
    play_local_bell,
    respond,
    synthesize_pcm16,
    strip_wake_prefix,
)


class WakePhraseTests(unittest.TestCase):
    def test_direct_english_phrase(self):
        self.assertTrue(is_direct_english_wake("Open claw, what time is it?"))
        self.assertTrue(is_direct_english_wake("OpenClaw"))

    def test_ambiguous_english_transcription_requires_confirmation(self):
        self.assertTrue(is_english_wake_candidate("Open cloud, keyword assault"))
        self.assertFalse(is_direct_english_wake("Open cloud, keyword assault"))
        self.assertTrue(is_english_wake_candidate("Open cloud, keyword assault"))
        self.assertTrue(is_portuguese_wake_confirmation("Oping Cloud, que horas são?"))
        self.assertFalse(is_portuguese_wake_confirmation("Open cloud services"))

    def test_wake_prefix_is_removed_from_command(self):
        self.assertEqual(strip_wake_prefix("Oping clau, que horas são?"), "que horas são?")
        self.assertEqual(strip_wake_prefix("OpenClaw"), "")
        self.assertEqual(strip_wake_prefix("Que horas são?"), "Que horas são?")


class WakeBellTests(unittest.TestCase):
    def test_wake_handler_pauses_microphone_and_rings_before_responding(self):
        events = []
        microphone = Mock()
        microphone.stop.side_effect = lambda: events.append("stop")
        microphone.start.side_effect = lambda: events.append("start")
        model = Mock()

        with (
            patch("voice_assistant.transcribe", return_value="OpenClaw, que horas são?"),
            patch("voice_assistant.play_local_bell", side_effect=lambda: events.append("bell")),
            patch("voice_assistant.respond", side_effect=lambda *args: events.append("respond")) as respond,
        ):
            handle_wake(microphone, model, b"captured audio", None)

        self.assertEqual(events, ["stop", "bell", "start", "respond"])
        self.assertEqual(
            respond.call_args.args,
            (microphone, model, "que horas são?"),
        )

    def test_command_capture_rings_after_recording_stops(self):
        events = []
        microphone = Mock()
        microphone.stop.side_effect = lambda: events.append("stop")
        microphone.start.side_effect = lambda: events.append("start")

        with (
            patch(
                "voice_assistant.transcribe",
                side_effect=lambda *args: events.append("transcribe") or "Que horas são?",
            ),
            patch(
                "voice_assistant.play_audio_cue",
                side_effect=lambda _microphone, cue_name: events.append(cue_name),
            ),
            patch("voice_assistant.speak", side_effect=lambda text: events.append("speak")),
            patch(
                "voice_assistant.capture_utterance",
                side_effect=lambda *args: events.append("capture") or b"command audio",
            ),
            patch("voice_assistant.respond", side_effect=lambda *args: events.append("respond")),
        ):
            handle_wake(microphone, Mock(), b"wake audio", "OpenClaw")

        self.assertEqual(
            events,
            [
                "Wake bell",
                "stop",
                "speak",
                "start",
                "Capture-start bell",
                "capture",
                "Capture-complete bell",
                "transcribe",
                "respond",
            ],
        )

    def test_play_local_bell_plays_the_local_bell_asset(self):
        with (
            patch("voice_assistant.WAKE_BELL_SOUND") as sound_path,
            patch("voice_assistant.subprocess.run", return_value=Mock(returncode=0)) as run,
        ):
            sound_path.is_file.return_value = True
            play_local_bell()

        run.assert_called_once()
        self.assertEqual(run.call_args.args[0], ["paplay", str(sound_path)])

    def test_play_local_bell_reports_playback_failure(self):
        with (
            patch("voice_assistant.WAKE_BELL_SOUND") as sound_path,
            patch("voice_assistant.subprocess.run", return_value=Mock(returncode=1)),
        ):
            sound_path.is_file.return_value = True
            with self.assertRaisesRegex(RuntimeError, "local bell playback failed"):
                play_local_bell()

    def test_wake_handler_continues_if_bell_playback_fails(self):
        microphone = Mock()
        model = Mock()

        with (
            patch("voice_assistant.transcribe", return_value="OpenClaw, olá"),
            patch("voice_assistant.play_local_bell", side_effect=RuntimeError("audio unavailable")),
            patch("voice_assistant.LOGGER.exception") as log_exception,
            patch("voice_assistant.respond") as respond,
        ):
            handle_wake(microphone, model, b"captured audio", None)

        log_exception.assert_called_once()
        respond.assert_called_once_with(microphone, model, "olá")
        microphone.stop.assert_called_once()
        microphone.start.assert_called_once()


class AudioGainTests(unittest.TestCase):
    def test_prepare_audio_amplifies_and_clips(self):
        pcm = np.array([1000, -1000, 10000, -10000], dtype=np.int16).tobytes()
        samples = prepare_audio(pcm, gain=4.0)
        self.assertAlmostEqual(float(samples[0]), 4000 / 32768, places=6)
        self.assertAlmostEqual(float(samples[1]), -4000 / 32768, places=6)
        self.assertEqual(float(samples[2]), 1.0)
        self.assertEqual(float(samples[3]), -1.0)

    def test_audio_to_pcm16_clips_float_samples(self):
        samples = np.array([-1.5, -0.5, 0.5, 1.5], dtype=np.float32)
        pcm = np.frombuffer(audio_to_pcm16(samples), dtype=np.int16)
        expected = np.array([-32767, -16383, 16383, 32767], dtype=np.int16)
        np.testing.assert_array_equal(pcm, expected)


class TtsSynthesisTests(unittest.TestCase):
    def test_synthesis_returns_pcm16_samples_and_sample_rate(self):
        samples = np.array([-0.5, 0.5], dtype=np.float32)
        kokoro = Mock()
        kokoro.create.return_value = (samples, 24000)

        with (
            patch("voice_assistant._KOKORO", kokoro),
            patch("voice_assistant.KOKORO_MODEL") as model_path,
            patch("voice_assistant.KOKORO_VOICES") as voices_path,
        ):
            model_path.is_file.return_value = True
            voices_path.is_file.return_value = True
            pcm, sample_rate = synthesize_pcm16("Olá")

        self.assertEqual(sample_rate, 24000)
        np.testing.assert_array_equal(np.frombuffer(pcm, dtype=np.int16), [-16383, 16383])
        kokoro.create.assert_called_once_with(
            "Olá",
            voice="pf_dora",
            speed=0.95,
            lang="pt-br",
        )


class GatewayChatTests(unittest.TestCase):
    def test_gateway_call_runs_the_configured_cli_without_a_shell(self):
        response = Mock(returncode=0, stdout='{"messages":[]}')

        with (
            patch("voice_assistant.OPENCLAW_COMMAND", ["openclaw"]),
            patch("voice_assistant.subprocess.run", return_value=response) as run,
        ):
            payload = gateway_call("chat.history", {"sessionKey": "test"})

        command = run.call_args.args[0]
        self.assertEqual(
            command[:4],
            ["openclaw", "gateway", "call", "chat.history"],
        )
        self.assertEqual(
            json.loads(command[command.index("--params") + 1]),
            {"sessionKey": "test"},
        )
        self.assertEqual(payload, {"messages": []})

    def test_voice_request_uses_webchat_chat_send_and_waits_for_final_reply(self):
        previous = {
            "role": "assistant",
            "content": [{"type": "text", "text": "Resposta anterior"}],
            "timestamp": 1,
        }
        initial_history = {
            "messages": [previous],
            "sessionInfo": {"hasActiveRun": False, "activeRunIds": []},
        }
        in_flight_history = {
            "messages": [previous],
            "sessionInfo": {"hasActiveRun": True, "activeRunIds": ["run-1"]},
        }
        final_history = {
            "messages": [
                previous,
                {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "Resposta pelo WebChat."}],
                    "timestamp": 2,
                },
            ],
            "sessionInfo": {"hasActiveRun": False, "activeRunIds": []},
        }

        with (
            patch(
                "voice_assistant.gateway_call",
                side_effect=[
                    initial_history,
                    {"runId": "run-1", "status": "started"},
                    in_flight_history,
                    final_history,
                ],
            ) as call_gateway,
            patch("voice_assistant.time.sleep"),
        ):
            response = ask_openclaw("Que horas são?")

        self.assertEqual(response, "Resposta pelo WebChat.")
        self.assertEqual(call_gateway.call_args_list[1].args[0], "chat.send")
        params = call_gateway.call_args_list[1].args[1]
        self.assertEqual(params["agentId"], "voice")
        self.assertEqual(
            params["sessionKey"],
            "agent:voice:explicit:openclaw-local-voice",
        )
        self.assertIn("Que horas são?", params["message"])
        self.assertTrue(params["idempotencyKey"])

    def test_consecutive_voice_requests_keep_the_same_session_context(self):
        user_message = {
            "role": "user",
            "content": [{"type": "text", "text": "Meu nome é Ana."}],
            "timestamp": 1,
        }
        first_reply = {
            "role": "assistant",
            "content": [{"type": "text", "text": "Prazer, Ana."}],
            "timestamp": 2,
        }
        second_user_message = {
            "role": "user",
            "content": [{"type": "text", "text": "Como eu me chamo?"}],
            "timestamp": 3,
        }
        second_reply = {
            "role": "assistant",
            "content": [{"type": "text", "text": "Você se chama Ana."}],
            "timestamp": 4,
        }
        initial_history = {
            "messages": [],
            "sessionInfo": {"hasActiveRun": False, "activeRunIds": []},
        }
        first_history = {
            "messages": [user_message, first_reply],
            "sessionInfo": {"hasActiveRun": False, "activeRunIds": []},
        }
        second_history = {
            "messages": [user_message, first_reply, second_user_message, second_reply],
            "sessionInfo": {"hasActiveRun": False, "activeRunIds": []},
        }

        with patch(
            "voice_assistant.gateway_call",
            side_effect=[
                initial_history,
                {"runId": "run-1"},
                first_history,
                first_history,
                {"runId": "run-2"},
                second_history,
            ],
        ) as call_gateway:
            first_answer = ask_openclaw("Meu nome é Ana.")
            second_answer = ask_openclaw("Como eu me chamo?")

        self.assertEqual(first_answer, "Prazer, Ana.")
        self.assertEqual(second_answer, "Você se chama Ana.")
        session_keys = [
            call.args[1]["sessionKey"]
            for call in call_gateway.call_args_list
        ]
        self.assertTrue(session_keys)
        self.assertEqual(set(session_keys), {"agent:voice:explicit:openclaw-local-voice"})


class VoiceTurnTests(unittest.TestCase):
    def test_response_opens_follow_up_capture_and_keeps_listening_for_next_turn(self):
        microphone = Mock()
        model = Mock()
        cues = []

        with (
            patch(
                "voice_assistant.ask_openclaw",
                side_effect=["Primeira resposta.", "Segunda resposta."],
            ) as ask,
            patch("voice_assistant.speak"),
            patch(
                "voice_assistant.capture_utterance",
                side_effect=[b"follow-up audio", None],
            ) as capture,
            patch(
                "voice_assistant.play_audio_cue",
                side_effect=lambda _microphone, cue_name: cues.append(cue_name),
            ),
            patch("voice_assistant.transcribe", return_value="E o segundo ponto?"),
        ):
            respond(microphone, model, "Qual o primeiro ponto?")

        self.assertEqual(
            [call.args[0] for call in ask.call_args_list],
            ["Qual o primeiro ponto?", "E o segundo ponto?"],
        )
        self.assertEqual(
            [call.args[1] for call in capture.call_args_list],
            [15, 15],
        )
        self.assertEqual(
            cues,
            [
                "Follow-up capture-start bell",
                "Follow-up capture-complete bell",
                "Follow-up capture-start bell",
                "Follow-up capture-complete bell",
            ],
        )
        self.assertEqual(microphone.stop.call_count, 2)
        self.assertEqual(microphone.start.call_count, 2)


if __name__ == "__main__":
    unittest.main()
