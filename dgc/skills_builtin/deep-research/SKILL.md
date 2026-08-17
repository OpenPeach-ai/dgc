---
name: deep-research
description: Answer a research question by fanning out multiple web searches from different angles, fetching the best sources, cross-checking claims, and synthesizing a cited summary.
---
Research question: $ARGUMENTS

Produce a well-sourced answer, not a single-search guess. Breadth of sources and cross-checking are the point.

1. Decompose the question. Break it into the distinct sub-questions and angles it actually contains (definition, current state, competing views, numbers/benchmarks, recent changes, caveats). Note what "a good answer" must cover.

2. Fan out searches. Run several web_search queries from DIFFERENT angles and vocabularies — don't just rephrase one query. Include the plain question, domain-specific terms, opposing framings, and date-qualified variants for anything time-sensitive. Prefer primary sources (official docs, papers, standards, first-party announcements) over aggregators.

3. Fetch and read. web_fetch the most promising results and read them — do not summarize from search snippets alone. Pull the specific figures, quotes, and dates that matter. Track each source URL.

4. Cross-check. For every load-bearing claim, confirm it against at least two independent sources. When sources disagree, say so and explain the disagreement rather than silently picking one. Distrust a single source, an undated page, or anything that merely echoes another source.

5. Synthesize. Write a clear, structured answer that leads with the direct conclusion, then supports it. Attribute claims inline with the source (name + URL). Keep your own reasoning separate from what the sources say.

6. Be honest about limits. Call out explicitly what you could NOT verify, what's contested, what's stale, and where you're inferring rather than citing. If the evidence is thin, say the answer is uncertain.

End with a short "Sources" list of the URLs you actually used. Never fabricate a citation, a statistic, or a quote — if you didn't read it, don't cite it.
