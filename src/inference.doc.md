# Inference

## Visão geral

Carrega Whisper local via Transformers.js e transcreve fala em CPU quantizada.

## Responsabilidades

- Configurar o cache local e o acesso remoto a modelos.
- Reutilizar a mesma pipeline entre transcrições.
- Converter PCM16 mono para o formato de entrada esperado pelo Whisper.

## Entradas e saídas

- Entrada: quadros PCM16 de 16 kHz e idioma `en` ou `pt`.
- Saída: texto reconhecido localmente.

## API / Assinatura

```ts
export function loadWhisper(
  allowRemoteModels?: boolean,
): Promise<AutomaticSpeechRecognitionPipelineType>;
export function transcribe(
  model: AutomaticSpeechRecognitionPipelineType,
  pcm: Buffer,
  language: "en" | "pt",
): Promise<string>;
```

## Fluxo principal

Carrega `onnx-community/whisper-small` em `q8`/CPU, amplifica e limita amostras,
e pede uma transcrição sem timestamps.

## Tratamento de erros e casos-limite

Falhas de download/modelo são propagadas. Em modo offline, somente modelos já
presentes no cache podem ser carregados.

## Exemplos

```ts
const text = await transcribe(await loadWhisper(), pcm, "pt");
```

## Dependências e integrações

Usa `@huggingface/transformers` e utilitários de `src/audio.ts`.
