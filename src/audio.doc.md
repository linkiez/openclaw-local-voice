# Audio

## Visão geral

Utilitários puros para wake word, limpeza de texto e conversão PCM16/WAV.

## Responsabilidades

- Normalizar variantes reconhecidas de “OpenClaw”.
- Preparar texto de resposta para fala sem registrar conteúdo.
- Validar e converter áudio mono PCM16.

## Entradas e saídas

- Recebe texto, `Buffer` PCM16 e amostras `Float32Array`.
- Retorna texto normalizado, amostras PCM16 ou contêiner WAV.

## API / Assinatura

```ts
export function stripWakePrefix(text: string): string;
export function pcm16ToFloat32(pcm: Buffer, gain: number): Float32Array;
export function audioToPcm16(samples: Float32Array): Buffer;
export function pcm16ToWav(pcm: Buffer, sampleRate: number): Buffer;
export function spokenText(text: string): string;
```

## Fluxo principal

1. Normaliza as palavras para comparar prefixos de wake word.
2. Clipa amostras no intervalo permitido antes de converter formatos.
3. Remove marcação e limita respostas faladas a 1.400 caracteres.

## Tratamento de erros e casos-limite

Rejeita PCM com número ímpar de bytes, ganho/amostragem inválidos e amostras
não finitas. Textos sem prefixo de wake word permanecem intactos.

## Exemplos

```ts
stripWakePrefix("Oping clau, que horas são?"); // "que horas são?"
```

## Dependências e integrações

Usa `Buffer` do Node.js. Não acessa rede, microfone ou arquivos.
