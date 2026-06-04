import React from 'react'

type MotionOnlyProps = {
  initial?: unknown
  animate?: unknown
  exit?: unknown
  transition?: unknown
  whileHover?: unknown
  whileTap?: unknown
  layout?: unknown
}

type MotionProps<T extends HTMLElement> = React.HTMLAttributes<T> & MotionOnlyProps

function stripMotionProps<T extends HTMLElement>({ initial: _initial, animate: _animate, exit: _exit, transition: _transition, whileHover: _whileHover, whileTap: _whileTap, layout: _layout, ...props }: MotionProps<T>) {
  return props
}

export const motion = {
  div: React.forwardRef<HTMLDivElement, MotionProps<HTMLDivElement>>((props, ref) => (
    <div ref={ref} {...stripMotionProps(props)} />
  )),
  button: React.forwardRef<HTMLButtonElement, MotionProps<HTMLButtonElement>>((props, ref) => (
    <button ref={ref} {...stripMotionProps(props)} />
  ))
}

export function AnimatePresence({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
