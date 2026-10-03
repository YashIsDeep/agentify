import type { AgentQuestion } from "@wm/shared";
import { ListChecks, MessageCircleQuestion, Send, SkipForward } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useApi } from "../api-context";
import { useTaskAction } from "../hooks";
import { combineAnswer, withRecommended } from "../lib/questions";
import { Button } from "../ui";

/**
 * A question the agent is blocked on. Rendered inline with its run, because that is where the
 * work actually stopped — the agent is sitting in its tool call until this is submitted.
 */
export function QuestionCard({ question }: { question: AgentQuestion }) {
  const api = useApi();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  // Typed beside a choice: your own answer when no option fits, or a note on the one you picked.
  const [notes, setNotes] = useState<Record<string, string>>({});
  const action = useTaskAction();

  const set = (id: string, value: string) => setAnswers((current) => ({ ...current, [id]: value }));
  const setNote = (id: string, value: string) => setNotes((current) => ({ ...current, [id]: value }));
  const final = Object.fromEntries(
    question.fields.map((field) => [field.id, combineAnswer(answers[field.id], field.kind === "choice" ? notes[field.id] : undefined)]),
  );
  const answered = question.fields.filter((field) => final[field.id]).length;
  const unpickedChoices = question.fields.some((field) => field.kind === "choice" && field.options?.length && !answers[field.id]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    action.mutate(() => api.answerQuestion(question.id, { answers: final, skip: false }));
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
                <input
                  className="question-note"
                  aria-label={`Your own answer, or a note on your choice: ${field.text}`}
                  placeholder="Your own answer, or a note…"
                  value={notes[field.id] ?? ""}
                  onChange={(event) => setNote(field.id, event.target.value)}
                />
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
        <Button
          variant="ghost"
          size="sm"
          icon={SkipForward}
          disabled={action.isPending}
          title="The agent carries on using its own judgement"
          onClick={() => action.mutate(() => api.answerQuestion(question.id, { answers: {}, skip: true }))}
        >
          Let it decide
        </Button>
        {unpickedChoices && (
          <Button
            variant="ghost"
            size="sm"
            icon={ListChecks}
            disabled={action.isPending}
            title="Picks the first option of each question you haven't answered: agents list their recommendation first"
            onClick={() => setAnswers((current) => withRecommended(question.fields, current))}
          >
            Use recommended
          </Button>
        )}
        <span className="spacer" />
        <span className="muted small">
          {answered} of {question.fields.length} answered
        </span>
        <Button type="submit" variant="primary" size="sm" icon={Send} disabled={answered === 0} loading={action.isPending} loadingText="Sending…">
          Send answer
        </Button>
      </div>
    </form>
  );
}
