import { useEffect, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { BarChart3, MessageSquare, Moon, Sun } from "lucide-react"

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command"
import { useTheme } from "@/hooks/use-theme"

/** App-wide command menu, toggled with Cmd/Ctrl+K. */
export function CommandMenu() {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const { theme, toggleTheme } = useTheme()

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setOpen((current) => !current)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  function run(action: () => void) {
    setOpen(false)
    action()
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command menu"
      description="Go to a page or change a setting."
      className="sm:max-w-lg"
    >
      <Command label="Command menu">
        <CommandInput placeholder="Type a command..." />
        <CommandList>
          <CommandEmpty>No matching command.</CommandEmpty>
          <CommandGroup heading="Pages">
            <CommandItem onSelect={() => run(() => navigate({ to: "/" }))}>
              <MessageSquare aria-hidden />
              Chat
            </CommandItem>
            {import.meta.env.DEV ? (
              // WHY: /bench returns 404 outside `bun run dev`.
              <CommandItem
                onSelect={() => run(() => navigate({ to: "/bench" }))}
              >
                <BarChart3 aria-hidden />
                Benchmark
              </CommandItem>
            ) : null}
          </CommandGroup>
          <CommandGroup heading="Settings">
            <CommandItem onSelect={() => run(toggleTheme)}>
              {theme === "dark" ? <Sun aria-hidden /> : <Moon aria-hidden />}
              {theme === "dark"
                ? "Switch to light mode"
                : "Switch to dark mode"}
              <CommandShortcut>D</CommandShortcut>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
