# video-engine

Motor de render de video da pipeline APOS-KIRO. Converte storyboard + imagens em video final com narração, karaoke e transições via Remotion.

## Defaults atuais do fluxo web

Quando a geração vem da UI local, o fluxo padrão para `@foiumaideia` é:

- duração: `60s`
- motor de imagem: `google-cloud`
- estilo de roteiro: `shortform_native`
- voz: `Iapetus`
- estilo de imagem do canal: `editorial_line_green`

Esses valores chegam do `web/server.mjs` e são gravados no job antes de chamar o motor de vídeo.

## Uso

Normalmente invocado pelo CLI principal (`scripts/foiumaideia.mjs`) ou pela UI web, mas pode ser usado diretamente:

```bash
cd video-engine
npm run make -- --title "Os idosos estao usando IA sem saber" --asset-mode no-browser
```

Com assets gerados localmente pelo pipeline:

```bash
npm run make -- --title "..." --asset-mode no-browser --local-assets-dir ../assets/envato/SLUG
```

## Scripts

```bash
npm run make -- --title "..."
npm run secrets:keychain
npm run publish:retry -- --dry-run
npm run validate -- --slug "2026-03-26-exemplo"
npm run studio
```

## Estrutura

- `scripts/make-video.mjs`: wrapper com agentes `sysadmin`, `dev`, `editor` e `qa`
- `scripts/make-plan1-video.mjs`: gera storyboard, voz, timeline e render
- `scripts/fetch-envato-overrides.mjs`: resolve assets locais gerados para o manifesto
- `scripts/lib/llm-provider.mjs`: integracao LLM (Gemini, OpenRouter)
- `scripts/lib/gemini-usage.mjs`: consolidacao local de tokens/custo estimado do Gemini
- `scripts/lib/tts.mjs`: TTS (Gemini) + STT (timestamps) + sync karaoke
- `scripts/lib/timings.mjs`: timeline, captions, karaoke timing
- `scripts/validate-run.mjs`: validacao E2E
- `scripts/rerender-voice.mjs`: re-render com nova voz sem regenerar imagens

## Notas

- `--asset-mode no-browser` nunca abre Chrome; usa apenas assets locais do slug.
- O preview e sempre regenerado por omissao. Usa `--reuse-preview` para velocidade.
- LLM provider: `gemini` (default). Na UI, a voz padrão atual é `Iapetus`.
- A UI local agora expõe também biblioteca de vídeos concluídos, jobs falhados e ações para reprocessar um job a partir do storyboard salvo.

## Gemini Usage E Cost

- `runs/<slug>/gemini-usage.json`: uso do Gemini no storyboard, revisao e plano grafico
- `assets/envato/<slug>/gemini-usage.json`: uso do Gemini no planner visual e na auditoria Gemini Vision
- `runs/<slug>/agent-report.json`: resumo combinado em `llmUsage`

O valor e estimado localmente a partir de `usageMetadata` devolvido pela Gemini API e do pricing oficial.

- snapshot de pricing usado no codigo: `2026-03-30`
- fonte oficial: https://ai.google.dev/gemini-api/docs/pricing

Observacoes:

- o valor guardado e uma estimativa, nao uma fatura oficial
- se uma chamada nao devolver `usageMetadata`, ela nao entra no calculo
- os modelos atualmente cobertos pelo estimador sao `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-2.0-flash` e `gemini-2.0-flash-lite`

## Image Prompt Rules

- `searchQuery` e `visualGoal` devem apontar para o mesmo assunto concreto
- `overlay` deve resumir o assunto real da cena e nao um rotulo generico reciclado de outro tema
- o pipeline agora evita overlays vagos como `No trabalho`, `Rotina`, `Pessoas` e `Novo normal` quando a narracao nao fala disso
- o fallback de overlay passou a derivar do proprio `title/narration` da cena
