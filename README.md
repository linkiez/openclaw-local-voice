# OpenClaw Local Voice

Assistente de voz para Linux com wake word, reconhecimento Whisper e síntese
Kokoro executados localmente. O áudio não é salvo nem enviado ao Gateway;
somente o texto reconhecido é enviado ao OpenClaw. Após uma resposta, o
assistente aceita seguimentos por até 15 segundos e então volta a aguardar a
wake word.

## Componentes

- `voice_assistant.py`: captura de áudio, wake word, transcrição local, conversa
  com o Gateway, campainhas e resposta falada.
- `audio_capture.py`: captura local do microfone e detecção dos trechos de fala.
- `tests/`: testes unitários executáveis com `unittest`.
- `systemd/`: exemplos de serviço do assistente e túnel SSH.
- `tools/openclaw-kokoro-remote-tts`: helper opcional para o Gateway gerar WAV
  com o Kokoro no node de voz.

A integração de voz no navegador não está incluída.

## Requisitos

- Linux com PipeWire/PulseAudio e os comandos `parec` e `paplay`.
- Python compatível com as versões de `requirements.txt`.
- CLI do OpenClaw instalada e configurada para acessar o Gateway.
- Modelos locais: cache Whisper em
  `~/.local/share/openclaw-voice/models/whisper/`, além de
  `kokoro-v1.0.onnx` e `voices-v1.0.bin` em
  `~/.local/share/openclaw-voice/models/kokoro/`.
- Para Kokoro com GPU, hardware e runtime CUDA compatíveis com
  `onnxruntime-gpu`.

Os modelos não são distribuídos neste repositório.

## Instalação

Clone o repositório em `~/.local/share/openclaw-voice`, crie o ambiente virtual e
instale as dependências:

```bash
git clone https://github.com/linkiez/openclaw-local-voice.git \
  ~/.local/share/openclaw-voice
python3 -m venv ~/.local/share/openclaw-voice/venv
~/.local/share/openclaw-voice/venv/bin/pip install \
  -r ~/.local/share/openclaw-voice/requirements.txt
```

Copie `.env.example` para
`~/.config/openclaw-voice-assistant.env` e ajuste o dispositivo de captura, o
limiar de áudio e o comando OpenClaw para o seu sistema. Se o Gateway exigir
autenticação, mantenha as credenciais em um arquivo local protegido; nunca
adicione esse arquivo ao Git.

Configure os aliases SSH `openclaw-gateway` e, se usar o helper TTS,
`openclaw-voice-node` em `~/.ssh/config`: configure `openclaw-gateway` no node
de voz e `openclaw-voice-node` no Gateway. Defina hosts, usuários e chaves da
sua infraestrutura local nessa configuração, fora do repositório. O serviço do
túnel encaminha `127.0.0.1:18790` para a porta local `127.0.0.1:18789` do
Gateway.

Instale as unidades de exemplo com os nomes esperados pelo systemd:

```bash
install -Dm644 systemd/openclaw-node-gateway-tunnel.service \
  ~/.config/systemd/user/openclaw-node-gateway-tunnel.service
install -Dm644 systemd/openclaw-voice-assistant.service \
  ~/.config/systemd/user/openclaw-voice-assistant.service
systemctl --user daemon-reload
systemctl --user enable --now openclaw-node-gateway-tunnel.service
systemctl --user enable --now openclaw-voice-assistant.service
```

O alias SSH do Gateway deve estar configurado antes de iniciar o túnel. Para
iniciar serviços de usuário sem sessão aberta, habilite o linger do usuário
com `loginctl enable-linger`.

## Testes

```bash
~/.local/share/openclaw-voice/venv/bin/python -m unittest discover \
  -s tests -p 'test_voice_assistant.py'
```

## Helper TTS remoto

Instale `tools/openclaw-kokoro-remote-tts` no Gateway e configure o provedor
local de TTS do OpenClaw para invocá-lo com `OUTPUT_PATH` e `TEXT`. O helper
conecta pelo alias SSH `openclaw-voice-node`; variáveis
`OPENCLAW_VOICE_NODE`, `OPENCLAW_VOICE_PYTHON` e `OPENCLAW_VOICE_SCRIPT`
permitem ajustar alias e caminhos. A configuração específica do Gateway não é
armazenada neste repositório.

## Privacidade

Não versione tokens, arquivos `.env`, `openclaw.json`, áudio, caches ou pesos de
modelos. O `.gitignore` cobre esses artefatos comuns. Revise qualquer arquivo
local antes de publicá-lo.
