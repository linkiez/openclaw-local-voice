import base64
import unittest

import numpy as np

from tools.kokoro_tts_worker import encode_audio, synthesize_text


class KokoroWorkerTests(unittest.TestCase):
    def test_encode_audio_clips_float_samples_as_pcm16(self):
        response = encode_audio(np.array([-1.5, -0.5, 0.5, 1.5]), 24_000)

        pcm16 = np.frombuffer(base64.b64decode(response["pcm16"]), dtype=np.int16)
        np.testing.assert_array_equal(pcm16, [-32767, -16383, 16383, 32767])
        self.assertEqual(response["sampleRate"], 24_000)

    def test_synthesis_preserves_the_existing_portuguese_voice(self):
        class KokoroStub:
            def __init__(self):
                self.call = None

            def create(self, text, **options):
                self.call = (text, options)
                return np.array([0.25, -0.25], dtype=np.float32), 24_000

        kokoro = KokoroStub()
        synthesize_text(kokoro, "Olá")

        self.assertEqual(
            kokoro.call,
            ("Olá", {"voice": "pf_dora", "speed": 0.95, "lang": "pt-br"}),
        )


if __name__ == "__main__":
    unittest.main()
