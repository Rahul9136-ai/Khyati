import { useWfm } from "@/store/wfm"
import { cn } from "@/lib/utils"

/** Centre-wide queue switcher shown in the top bar. */
export function QueuePicker() {
  const { queues, queueId, setQueueId } = useWfm()
  return (
    <div className="hidden items-center gap-1 rounded-lg border bg-card/60 p-1 sm:flex">
      {queues.map((q) => (
        <button
          key={q.id}
          onClick={() => setQueueId(q.id)}
          className={cn(
            "rounded-md px-3 py-1 text-xs font-semibold transition-colors",
            q.id === queueId ? "text-white" : "text-muted-foreground hover:text-foreground",
          )}
          style={q.id === queueId ? { background: q.color } : undefined}
        >
          {q.name}
        </button>
      ))}
    </div>
  )
}
