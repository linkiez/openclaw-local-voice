# Capture

## Visão geral

Captura áudio mono PCM16 com `parec` e identifica trechos de fala por RMS.

## Responsabilidades

- Iniciar e encerrar o processo de captura sem shell.
- Ler quadros de 100 ms com timeout opcional.
- Manter pré-roll, detectar silêncio e limitar duração da fala.

## Entradas e saídas

- Entrada: fonte PipeWire/PulseAudio, limiar RMS e janela opcional.
- Saída: `Buffer` PCM16 ou `null` quando não há fala válida.

## API / Assinatura

```ts
export class Microphone implements AudioFrameSource;
export function captureUtterance(
  microphone: AudioFrameSource,
  timeoutMs?: number,
): Promise<Buffer | null>;
```

## Fluxo principal

`parec` → quadros PCM16 de 100 ms → pré-roll de 5 quadros → início após 2 quadros
altos → fim após 7 quadros silenciosos ou 12 segundos.

## Tratamento de erros e casos-limite

Falhas de inicialização, ausência de saída de áudio, fechamento do stream e
leitura concorrente rejeitam a operação. Quadros curtos não constituem uma fala
válida.

## Exemplos

```ts
const microphone = new Microphone();
await microphone.start();
const pcm = await captureUtterance(microphone, 8_000);
await microphone.stop();
```

## Dependências e integrações

Requer `parec`, PipeWire/PulseAudio e configuração em `src/config.ts`.
