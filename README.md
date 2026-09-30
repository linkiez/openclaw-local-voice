# OpenClaw Local Voice

Assistente de voz local para Linux com wake word, transcrição Whisper, conversa
contínua com OpenClaw e campainhas no início e no fim da captura. A captura,
detecção de fala, Whisper e comunicação com o Gateway rodam em Node.js/TypeScript.
O áudio fica local; somente a transcrição é enviada ao Gateway.

O worker Kokoro permanece em Python para manter a voz brasileira `pf_dora`,
indisponível nas vozes fornecidas por `kokoro-js`. Ele é chamado localmente pelo
processo TypeScript, mantém o modelo carregado entre respostas e não registra o
texto falado.

## Requisitos

- Linux com PipeWire/PulseAudio, `parec` e `paplay`.
- Node.js 22 ou superior.
- Python 3.11 ou superior e runtime CUDA compatível com `onnxruntime-gpu`.
- CLI do OpenClaw configurada para acessar o Gateway.
- Uma saída de áudio disponível para as campainhas e a voz.

Os pesos são baixados para `~/.local/share/openclaw-voice/models/` e não são
incluídos no repositório. O cache Whisper usa CPU quantizada; o worker Kokoro
usa CUDA e a voz `pf_dora`.

## Instalação

Clone em `~/.local/share/openclaw-voice`, compile o runtime e instale as
dependências Python necessárias somente para Kokoro:

```bash
git clone https://github.com/linkiez/openclaw-local-voice.git \
  ~/.local/share/openclaw-voice
cd ~/.local/share/openclaw-voice
npm ci
npm run build
python3 -m venv venv
venv/bin/pip install -r requirements.txt
npm run models:download
```

O download inclui o Whisper e os arquivos ONNX/vozes do Kokoro. Ele pode usar
centenas de megabytes. Não execute `models:download` sob
`HF_HUB_OFFLINE=1`.

Copie `.env.example` para
`~/.config/openclaw-voice-assistant.env` e ajuste o microfone e o comando
OpenClaw. `OPENCLAW_COMMAND` deve ser um único executável, sem argumentos
adicionais. O worker Python padrão fica em
`~/.local/share/openclaw-voice/venv/bin/python`.

Configure os aliases SSH `openclaw-gateway` e, para o helper TTS remoto,
`openclaw-voice-node` em `~/.ssh/config`. Mantenha hosts, usuários e chaves fora
do repositório. O túnel encaminha `127.0.0.1:18790` para a porta local
`127.0.0.1:18789` do Gateway.

O serviço pressupõe Node em
`~/.nvs/node/24.15.0/x64/bin/node`; ajuste `ExecStart` em
`systemd/openclaw-voice-assistant.service` se estiver em outro local. Instale e
ative as unidades:

```bash
install -Dm644 systemd/openclaw-node-gateway-tunnel.service \
  ~/.config/systemd/user/openclaw-node-gateway-tunnel.service
install -Dm644 systemd/openclaw-voice-assistant.service \
  ~/.config/systemd/user/openclaw-voice-assistant.service
systemctl --user daemon-reload
systemctl --user enable --now openclaw-node-gateway-tunnel.service
systemctl --user enable --now openclaw-voice-assistant.service
```

Habilite o linger para iniciar os serviços sem sessão aberta:
`loginctl enable-linger`.

## Testes

```bash
npm test
venv/bin/python -m unittest discover -s tests -p 'test_kokoro_worker.py'
```

## Helper TTS remoto

Compile e execute `dist/tools/openclaw-kokoro-remote-tts.js` no Gateway com
`OUTPUT_PATH` e `TEXT`. O helper conecta pelo alias SSH
`openclaw-voice-node` e valida o WAV antes de gravá-lo. Configure
`OPENCLAW_VOICE_NODE_BIN` e `OPENCLAW_VOICE_TTS_SCRIPT` no ambiente do Gateway
quando os caminhos padrão de Node ou do script no node de voz forem diferentes.

## Privacidade

Não versione tokens, arquivos `.env`, `openclaw.json`, áudio, caches ou pesos de
modelos. O `.gitignore` cobre esses artefatos. Áudio e transcrições não são
registrados em logs.
