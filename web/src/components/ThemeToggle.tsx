import { Moon, Sun } from "lucide-react";
import { cls } from "../lib/format";
import { setThemePreference, useThemePreference, type ThemePreference } from "../lib/theme";

const OPTIONS: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light theme", icon: Sun },
  { value: "dark", label: "Dark theme", icon: Moon },
];

export function ThemeToggle() {
  const preference = useThemePreference();
  return (
    <div className="theme-toggle" role="radiogroup" aria-label="Theme">
      {OPTIONS.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={preference === value}
          aria-label={label}
          title={label}
          className={cls("theme-option", preference === value && "theme-option-active")}
          onClick={() => setThemePreference(value)}
        >
          <Icon size={14} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

