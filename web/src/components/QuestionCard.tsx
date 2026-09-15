import type { AgentQuestion } from "@wm/shared";
import { MessageCircleQuestion, Send, SkipForward } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useApi } from "../api-context";
import { useTaskAction } from "../hooks";

/**
 * A question the agent is blocked on. Rendered inline with its run, because that is where the
 * work actually stopped — the agent is sitting in its tool call until this is submitted.
 */
export function QuestionCard({ question }: { question: AgentQuestion }) {
  const api = useApi();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const action = useTaskAction();

  const set = (id: string, value: string) => setAnswers((current) => ({ ...current, [id]: value }));
  const answered = question.fields.filter((field) => answers[field.id]?.trim()).length;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    action.mutate(() => api.answerQuestion(question.id, { answers, skip: false }));
  };

  return (
    <form className="question-card" onSubmit={submit}>
      <header className="question-head">
        <MessageCircleQuestion size={16} />
        <strong>The agent is waiting on you</strong>
      </header>

      {question.preamble && <p className="question-preamble">{question.preamble}</p>}

      <ol className="question-fields">
        {question.fields.map((field) => (
          <li key={field.id} className="question-field">
            <span className="question-text">{field.text}</span>
            {field.kind === "choice" ? (
              <div className="question-options">
                {(field.options ?? []).map((option) => (
                  <label key={option} className="question-option">
                    <input
                      type="radio"
                      name={`${question.id}-${field.id}`}
                      value={option}
                      checked={answers[field.id] === option}
                      onChange={() => set(field.id, option)}
                    />
                    <span>{option}</span>
                  </label>
                ))}
              </div>
            ) : field.multiline ? (
              <textarea rows={3} value={answers[field.id] ?? ""} onChange={(event) => set(field.id, event.target.value)} />
            ) : (
              <input value={answers[field.id] ?? ""} onChange={(event) => set(field.id, event.target.value)} />
            )}
          </li>
        ))}
      </ol>

      <div className="question-actions">
        <button
          type="button"
          className="button ghost small"
          disabled={action.isPending}
          title="The agent carries on using its own judgement"
          onClick={() => action.mutate(() => api.answerQuestion(question.id, { answers: {}, skip: true }))}
        >
          <SkipForward size={13} />
          Let it decide
        </button>
        <span className="spacer" />
        <span className="muted small">
          {answered} of {question.fields.length} answered
        </span>
        <button type="submit" className="button primary small" disabled={action.isPending || answered === 0}>
          <Send size={13} />
          {action.isPending ? "Sending…" : "Send answer"}
        </button>
      </div>
    </form>
  );
}
