import {
  Bot,
  Sparkles,
  ChartNoAxesCombined,
  BookOpen,
  Search,
  Code,
  Pen,
  Shield,
  Briefcase,
  Globe,
  Calculator,
  Lightbulb,
} from "lucide-react";
import { cn } from "@/lib/utils";
export const agentIcons = {
  bot: Bot,
  sparkles: Sparkles,
  chart: ChartNoAxesCombined,
  book: BookOpen,
  search: Search,
  code: Code,
  pen: Pen,
  shield: Shield,
  briefcase: Briefcase,
  globe: Globe,
  calculator: Calculator,
  lightbulb: Lightbulb,
};
export const agentColors = {
  blue: "#8bb9fa",
  violet: "#c4a5ff",
  rose: "#ffa3bb",
  orange: "#ffb083",
  amber: "#f4cf73",
  green: "#87d7a0",
  teal: "#79d5cd",
  slate: "#b7c5d7",
};
export function AgentIdentity({ icon, color, className }: { icon?: string; color?: string; className?: string }) {
  const Icon = agentIcons[icon as keyof typeof agentIcons] ?? Bot;
  const tone = agentColors[color as keyof typeof agentColors] ?? agentColors.blue;
  return (
    <span
      className={cn(
        "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl [&>svg]:h-5 [&>svg]:w-5",
        className,
      )}
      style={{ color: tone, backgroundColor: `${tone}18` }}
    >
      <Icon aria-hidden="true" />
    </span>
  );
}
