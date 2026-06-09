import { useRole, roleLabels } from "@/lib/role-context";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UserCog } from "lucide-react";

export function RoleSwitcher() {
  const { role, setRole } = useRole();
  return (
    <div className="flex items-center gap-2 rounded-full border border-border glass-panel px-3 py-1.5">
      <UserCog className="h-4 w-4 text-accent" />
      <span className="text-xs text-muted-foreground hidden sm:inline">Perfil:</span>
      <Select value={role} onValueChange={(v) => setRole(v as never)}>
        <SelectTrigger className="h-7 w-[130px] border-0 bg-transparent text-xs focus:ring-0 focus:ring-offset-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(roleLabels) as Array<keyof typeof roleLabels>).map((r) => (
            <SelectItem key={r} value={r}>
              {roleLabels[r]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}