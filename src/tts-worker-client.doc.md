# TTS Worker Client

## Visão geral

Mantém a comunicação NDJSON com o worker Python que conserva a voz `pf_dora`.

## Responsabilidades

- Iniciar um único processo worker local e encaminhar solicitações.
- Validar respostas, sample rate, base64 e alinhamento PCM16.
- Encerrar o processo no desligamento e rejeitar operações pendentes em falhas.

## Entradas e saídas

- Entrada: texto plain text limitado pelo módulo de áudio.
- Saída: sample rate e áudio PCM16 em memória.

## API / Assinatura

```ts
export function parseTtsResponse(line: string): PcmAudio;
export class KokoroWorkerClient {
  synthesize(text: string): Promise<PcmAudio>;
  warmUp(): Promise<void>;
  close(): Promise<void>;
}
```

## Fluxo principal

Envia uma linha JSON → recebe uma linha JSON com áudio base64 → valida e
decodifica sem gravar o texto ou o áudio. Uma síntese curta aquece o modelo
antes da primeira resposta falada.

## Tratamento de erros e casos-limite

Respostas JSON inválidas, áudio vazio, worker fechado ou falha de processo
rejeitam a solicitação; não há fallback silencioso de voz.

## Exemplos

```ts
const audio = await worker.synthesize("Olá");
```

## Dependências e integrações

Usa processos padrão do Node.js e `tools/kokoro_tts_worker.py`.
