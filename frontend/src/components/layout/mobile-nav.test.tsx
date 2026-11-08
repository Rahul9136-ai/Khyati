import { fireEvent, render, screen, within } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { describe, expect, it } from "vitest"

import { MobileNav } from "./sidebar"

const show = () => render(
  <MemoryRouter initialEntries={["/"]}>
    <Routes><Route path="*" element={<MobileNav canSee={() => true} footer={<p>Purvi.AI</p>} />} /></Routes>
  </MemoryRouter>,
)

describe("menu on small screens", () => {
  it("opens the left pane as a drawer, and closes on a page pick, the X, outside or Escape", () => {
    show()
    const button = screen.getByRole("button", { name: "Open menu" })
    expect(button).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByRole("dialog", { name: "Menu" })).toBeNull()

    fireEvent.click(button)
    const menu = screen.getByRole("dialog", { name: "Menu" })
    expect(within(menu).getByRole("navigation", { name: "Main" })).toBeInTheDocument()
    expect(button).toHaveAttribute("aria-expanded", "true")

    // picking a page closes it
    fireEvent.click(within(menu).getByRole("button", { name: /^Reports & Insights/ }))
    fireEvent.click(within(screen.getByRole("dialog", { name: "Menu" })).getByRole("link", { name: "Methodology" }))
    expect(screen.queryByRole("dialog", { name: "Menu" })).toBeNull()

    fireEvent.click(button)
    fireEvent.click(screen.getByRole("button", { name: "Close menu" }))
    expect(screen.queryByRole("dialog", { name: "Menu" })).toBeNull()

    fireEvent.click(button)
    fireEvent.keyDown(window, { key: "Escape" })
    expect(screen.queryByRole("dialog", { name: "Menu" })).toBeNull()
  })
})
