# Claude Source Brief Template

Use this prompt with Claude when you want a source brief that Gemini can read reliably through the `source text` field.

## Prompt for Claude

```text
Transform the topic below into a structured factual brief for a short-form video generator.

Rules:
- Return plain text only.
- Keep the section headers exactly as written below.
- Do not generate a final storyboard JSON.
- Do not write camera directions, music cues, logo notes, fade notes, or editing instructions.
- Focus on factual anchors, chronology, required beats, tone, and what to avoid.
- Keep it concise but concrete.
- If there is uncertainty, prefer historically cautious wording.

Output format:

[TITULO]
One strong title in Portuguese.

[BASE FACTUAL]
- 4 to 10 bullet points with the core verified facts.

[CRONOLOGIA]
- 3 to 8 bullet points in time order.

[NUMEROS OBRIGATORIOS]
- Important dates, prices, counts, valuations, store counts, user counts, or scale facts.

[BEATS OBRIGATORIOS]
- 5 to 10 concrete human or ironic beats that must appear in the final video.
- Prefer memorable actions, refusals, phrases, objects, awkward details, and reversals.

[TOM]
One short paragraph describing the desired tone.
Example: "Storytelling de surpresa e ironia, sem tom de coach, sem moral da historia, sem conselho direto ao espectador."

[EVITAR]
- Things the final script should not do.
- Example items: CTA, moral da historia, texto legivel em imagem, split-screen, excesso de cenas genericas.

[FECHAMENTO DESEJADO]
One short paragraph describing how the story should land.
Example: "Fechar no fato ironico e no contraste final, sem licao explicita."

[CONTEXTO EXTRA]
- Optional supporting details that help but are not mandatory.

Topic:
PASTE THE TOPIC HERE
```

## Recommended shape

Best use case:
- factual story with a clear reversal
- strong dates or numbers
- a few memorable beats

Avoid asking Claude for:
- ready-made scene timing
- detailed visual directions per scene
- thumbnail prompt
- stock-footage search queries

That works better when Gemini builds the storyboard from the structured brief.

## Example skeleton

```text
[TITULO]
A Starbucks quase faliu vendendo so graos de cafe

[BASE FACTUAL]
- A Starbucks original foi fundada em 1971 em Seattle.
- No inicio vendia apenas graos, equipamentos e cafe para preparar em casa.
- Howard Schultz entrou na empresa em 1982.

[CRONOLOGIA]
- 1971: fundacao em Seattle.
- 1982: Schultz entra.
- 1983: viagem para Milao.

[NUMEROS OBRIGATORIOS]
- 1971
- 1982
- 1983
- 1987
- US$ 3,8 milhoes

[BEATS OBRIGATORIOS]
- Starbucks existiu anos sem vender cafe pronto
- Schultz volta obcecado com espresso bars italianas
- fundadores recusam a ideia
- Schultz sai e abre Il Giornale
- Schultz compra a Starbucks

[TOM]
Storytelling de surpresa e ironia, sem tom de coach e sem conselho direto ao espectador.

[EVITAR]
- moral da historia
- CTA
- visual genérico de empreendedorismo

[FECHAMENTO DESEJADO]
Fechar no contraste entre a recusa inicial e o tamanho que a empresa atingiu depois.

[CONTEXTO EXTRA]
- Os fundadores viam cafe pronto como algo abaixo da dignidade do produto.
```
