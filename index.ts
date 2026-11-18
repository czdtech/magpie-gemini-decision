// Bridges magpie's System One decision routing to Google's Gemini Decisions API.
// magpie posts {model, questions, state} to this provider's loader fetch; we translate
// to POST /v1beta/decisions, call Google with the account key, and translate the
// calibrated answers back to System One's {model, answers:{<q>:{noul|choice|score, confidence, probabilities}}}.

const PROVIDER = "gemini-decision"
const MODEL = "gemini-decision-1"
const GOOGLE_URL = "https://generativelanguage.googleapis.com/v1beta/decisions"

function stateToInput(state: any): any {
  if (state == null) return ""
  if (typeof state === "string") return state
  if (Array.isArray(state)) return state.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join("\n")
  if (typeof state === "object") {
    // The classifier's questions reference state fields by name (message, kinds[N],
    // previous_user_message…). Keep the whole object as JSON so every named field reaches
    // Google; a lone message/text is just the input text, and messages[] is a conversation.
    const keys = Object.keys(state)
    if (keys.length === 1 && typeof state.text === "string") return state.text
    if (keys.length === 1 && typeof state.message === "string") return state.message
    if (Array.isArray(state.messages)) {
      return state.messages
        .map((m: any) => `${m.role ?? "user"}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
        .join("\n")
    }
    return JSON.stringify(state)
  }
  return String(state)
}

function toGoogleQuestion(q: any, key = ""): any {
  const type = q.type === "predicate" ? "noul" : q.type
  const out: any = { type }
  if (type === "choice") {
    let criteria: Record<string, string> = {}
    if (q.criteria && typeof q.criteria === "object" && !Array.isArray(q.criteria)) {
      criteria = q.criteria
    } else {
      const opts = Array.isArray(q.choices) ? q.choices : Array.isArray(q.criteria) ? q.criteria : []
      for (const c of opts) criteria[String(c)] = ""
    }
    out.criteria = criteria
  } else if (type === "score") {
    out.criteria = Array.isArray(q.criteria) ? q.criteria : Array.isArray(q.levels) ? q.levels : []
  } else if (type === "noul") {
    if (q.criteria && typeof q.criteria === "object" && !Array.isArray(q.criteria)) out.criteria = q.criteria
    else if (q.true_description || q.false_description) {
      out.criteria = { true_description: q.true_description ?? "", false_description: q.false_description ?? "" }
    }
  }
  let instructions = q.instructions ?? q.question ?? ""
  if (!instructions) {
    if (type === "choice") instructions = `Classify the input into one of: ${Object.keys(out.criteria ?? {}).join(", ")}.`
    else if (type === "score") instructions = "Rate the input on the given scale, from lowest to highest."
    else instructions = key ? `Does the input satisfy "${key}"?` : "Does the statement hold for the input?"
  }
  out.instructions = instructions
  return out
}

function fromGoogleAnswer(a: any): any {
  if (!a) return {}
  // magpie reads noul from the `noul` field (jevLevelled), choice from `choice` +
  // `probabilities` (readJev/sureOf), and score from `score`. Pass each through as Google gave it.
  if (a.type === "noul") return { noul: a.noul, confidence: a.confidence }
  if (a.type === "choice") return { choice: a.choice, confidence: a.confidence, probabilities: a.probabilities }
  if (a.type === "score") return { score: a.score, confidence: a.confidence, probabilities: a.probabilities }
  return { confidence: a.confidence }
}

export const _internal = { stateToInput, toGoogleQuestion, fromGoogleAnswer }

export const GeminiDecisionPlugin = async ({ client }: any) => ({
  config: async (cfg: any) => {
    cfg.provider ??= {}
    cfg.provider[PROVIDER] ??= {
      name: "Gemini Decision",
      decide: true,
      api: "https://generativelanguage.googleapis.com/v1beta",
      models: {
        [MODEL]: { name: "Gemini Decision 1", decides: true, limit: { context: 262144, output: 1 } },
      },
    }
  },

  auth: {
    provider: PROVIDER,
    methods: [{ type: "api", label: "Google AI Studio key", placeholder: "AQ.…" }],
    async loader(getAuth: any) {
      const auth = await getAuth()
      if (auth?.type !== "api") return {}
      const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || undefined
      return {
        baseURL: "https://generativelanguage.googleapis.com/v1beta",
        async fetch(_input: any, init: any) {
          const body = JSON.parse(init.body)
          console.error("[gemini-decision] System One in:", JSON.stringify(body))
          const questions: Record<string, any> = {}
          for (const [k, q] of Object.entries(body.questions ?? {})) questions[k] = toGoogleQuestion(q, k)
          const gBody = { model: MODEL, input: stateToInput(body.state), questions }
          const res = await fetch(GOOGLE_URL, {
            method: "POST",
            headers: { "x-goog-api-key": auth.key, "Content-Type": "application/json" },
            body: JSON.stringify(gBody),
            signal: init.signal,
            ...(proxy ? { proxy } : {}),
          } as any)
          const text = await res.text()
          if (!res.ok) {
            console.error("[gemini-decision] Google error:", res.status, text)
            return new Response(text, { status: res.status, headers: { "Content-Type": "application/json" } })
          }
          const g = JSON.parse(text)
          const answers: Record<string, any> = {}
          for (const [k, a] of Object.entries(g.answers ?? {})) answers[k] = fromGoogleAnswer(a)
          const out = {
            model: body.model,
            answers,
            usage: { input_tokens: g.usage?.total_input_tokens ?? 0, output_tokens: g.usage?.total_output_tokens ?? 0 },
          }
          console.error("[gemini-decision] System One out:", JSON.stringify(out))
          return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } })
        },
      }
    },
  },

  provider: {
    id: PROVIDER,
    async models(provider: any) {
      return provider.models
    },
  },
})