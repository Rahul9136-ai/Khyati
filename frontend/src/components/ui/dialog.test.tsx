import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { Dialog } from "@/components/ui/dialog"

describe("Dialog", () => {
  it("renders into <body>, outside the card it was opened from", () => {
    // A card with backdrop-filter (.glass) would otherwise trap the `fixed`
    // dialog inside it — cut off and behind the rest of the page.
    const { container } = render(
      <div className="glass" data-testid="card">
        <Dialog open onClose={() => {}} title="Generate schedules">body</Dialog>
      </div>,
    )
    const dialog = screen.getByRole("dialog", { name: undefined })
    expect(container.contains(dialog)).toBe(false)
    expect(dialog.closest("body > div")?.parentElement).toBe(document.body)
    expect(screen.getByTestId("card")).toBeEmptyDOMElement()
  })

  it("closes on Escape and on the backdrop", () => {
    const onClose = vi.fn()
    render(<Dialog open onClose={onClose} title="T">x</Dialog>)
    fireEvent.keyDown(document, { key: "Escape" })
    fireEvent.click(screen.getByRole("dialog").previousElementSibling!)
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
