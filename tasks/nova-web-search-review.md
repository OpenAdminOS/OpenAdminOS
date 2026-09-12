# Nova web research and cache latency review

Implemented on the existing Cache/Nova preview branch.

- OpenAI Voice passes a main-process, session-scoped `web_search` capability into the shared Chat tool loop. The selected reasoning model chooses public research, tenant retrieval, or both. Local voice and ordinary typed Chat receive no hosted-search capability.
- Research uses OpenAI Responses with GPT-5.4 mini, required hosted search after the agent elects to research, no Responses storage, a bounded standalone query, timeout/cancellation and bounded response/evidence sizes. Session sharing copy includes searches and API charges.
- Provider citations persist alongside the tool trace and appear as accessible external links in Chat. Source URLs are not read aloud. Missing/failed search evidence cannot silently become a successful current-facts answer.
- Voice tool descriptions are compact so combined questions have room for evidence. Natural unfiltered counts, OS-version and encryption questions use existing exact snapshot aggregates without reasoning calls. Anchored matching leaves compound public comparisons in the tool loop.

Validation:

- Desktop backend suite: 280 tests passed; renderer: 119 tests passed. TypeScript, desktop build and Graph QA were checked. QA requires the locally installed msgraph skill path (182 pass, four existing warnings, zero failures).
- Live OpenAI search completed for current Intune announcements and Windows/macOS public guidance, returning primary-source citations. A first GPT-4.1-mini attempt produced weak research summaries; GPT-5.4 mini replaced it and was retested. Citation presence does not guarantee every inference is correct.
- The production tool loop with live GPT-5.4-mini reasoning and real OpenAI search selected `web_search` for a public-only question, `list_cached_resources` + `query_cache` + `web_search` for a combined question, and only `query_cache` for an encryption question. Tenant rows in this loop test were isolated fixtures, not the desktop's delegated MSAL connection. No live microphone or GPT-Live audio session was exercised in this pass.
- The locally installed OpenAdmin 8B model selected tools inconsistently and made incorrect inferences in the same fixture test. General model-driven answer quality remains a limitation of that reasoning model; the integration does not guarantee autonomous tool selection for every local model. A capable reasoning model is required for research. The exact-summary shortcuts avoid this issue for common inventory questions.
- Read-only Lokka Graph `/beta` verified device fields, a continuation page and structured HTTP 400 on an invalid field. No Graph writes were performed.
- Fifteen warm fixture-backed backend requests for natural inventory phrasing had a median of about 152 ms and a slowest sample of 164 ms, with zero reasoning calls. This excludes speech recognition, transport, voice generation and real Graph refresh, and is not an end-to-end voice latency promise.
- Source UI browser checks covered 1280×720 and 375×812, including accessible links and no horizontal overflow. Screenshots use the production source component with fixture content. The standalone fixture's missing favicon was its only browser console error.

The API key used for verification was provided through non-echoed process input and
held only in memory. Test processes ended without persisting it in app settings or
repository files. The user should rotate the key shared in conversation.
