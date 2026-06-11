import { Building2, Check, ChevronsUpDown } from "lucide-react";
import { useTenant } from "@/lib/tenant-context";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";

export function TenantSwitcher() {
  const { tenants, activeTenant, setActiveTenantId, loading, isSuper } = useTenant();
  const [open, setOpen] = useState(false);

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-full border border-border glass-panel px-3 py-1.5 text-xs text-muted-foreground">
        <Building2 className="h-4 w-4" />
        Carregando…
      </div>
    );
  }

  if (tenants.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-full border border-destructive/40 px-3 py-1.5 text-xs text-destructive">
        <Building2 className="h-4 w-4" /> Sem empresas
      </div>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          role="combobox"
          className="h-9 gap-2 rounded-full glass-panel border-border"
        >
          <Building2 className="h-4 w-4 text-accent" />
          <span className="max-w-[160px] truncate">{activeTenant?.nome ?? "Selecionar empresa"}</span>
          {isSuper && <Badge variant="outline" className="text-[10px] py-0">DEV</Badge>}
          <ChevronsUpDown className="h-3.5 w-3.5 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="end">
        <Command>
          <CommandInput placeholder="Buscar empresa…" />
          <CommandList>
            <CommandEmpty>Nenhuma empresa.</CommandEmpty>
            <CommandGroup heading={isSuper ? "Todas as empresas" : "Suas empresas"}>
              {tenants.map((t) => (
                <CommandItem
                  key={t.id}
                  value={`${t.nome} ${t.slug}`}
                  onSelect={async () => {
                    setOpen(false);
                    if (t.id !== activeTenant?.id) await setActiveTenantId(t.id);
                  }}
                  className="flex items-center justify-between"
                >
                  <div className="flex flex-col">
                    <span className="text-sm">{t.nome}</span>
                    <span className="text-[10px] text-muted-foreground">{t.slug}</span>
                  </div>
                  {activeTenant?.id === t.id && <Check className="h-4 w-4 text-primary" />}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}