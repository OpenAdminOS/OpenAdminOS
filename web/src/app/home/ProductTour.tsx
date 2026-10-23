"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import type { AppScreen } from "./AppShot";
import { AppShot } from "./AppShot";
import type { StageTone } from "./Stage";

export interface TourItem {
  id: string;
  title: string;
  text: string;
  screen: AppScreen;
  alt: string;
  tone: StageTone;
  link?: { href: string; label: string };
}

const ADVANCE_MS = 7000;

/**
 * Accordion of product areas with the matching real capture on an art stage.
 * Advances on its own while visible until the visitor picks an item; reduced
 * motion turns the auto-advance off.
 */
export function ProductTour({ items }: { items: readonly TourItem[] }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [auto, setAuto] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setAuto(true);
    const root = rootRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(Boolean(entry?.isIntersecting)),
      { threshold: 0.3 },
    );
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!auto || !visible) return;
    const timer = window.setTimeout(
      () => setActive((current) => (current + 1) % items.length),
      ADVANCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [active, auto, visible, items.length]);

  function choose(index: number) {
    setAuto(false);
    setActive(index);
  }

  const current = items[active]!;

  return (
    <div
      ref={rootRef}
      className="grid gap-10 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:gap-14"
    >
      <ol className="border-t border-brand-line">
        {items.map((item, index) => {
          const isActive = index === active;
          return (
            <li key={item.id} className="border-b border-brand-line">
              <button
                type="button"
                aria-expanded={isActive}
                aria-controls={`tour-panel-${item.id}`}
                onClick={() => choose(index)}
                className="flex w-full items-baseline gap-4 py-5 text-left"
              >
                <span className="w-6 shrink-0 font-mono text-xs text-brand-faint">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span
                  className={`font-display text-[1.45rem] leading-tight transition-colors ${
                    isActive ? "text-brand-ink" : "text-brand-faint hover:text-brand-ink"
                  }`}
                >
                  {item.title}
                </span>
              </button>
              <div
                id={`tour-panel-${item.id}`}
                hidden={!isActive}
                className="pb-6 pl-10"
              >
                <p className="text-[15px] leading-7 text-brand-muted">
                  {item.text}
                </p>
                {item.link ? (
                  <Link href={item.link.href} className="text-link mt-3 inline-flex text-sm">
                    {item.link.label}
                  </Link>
                ) : null}
                {auto && visible ? (
                  <span
                    aria-hidden
                    key={`${item.id}-${active}`}
                    className="tour-progress mt-5 block h-px bg-brand-ink"
                    style={{ animationDuration: `${ADVANCE_MS}ms` }}
                  />
                ) : null}
                <div
                  className={`stage stage-${item.tone} mt-6 overflow-hidden rounded-[14px] p-4 lg:hidden`}
                >
                  <AppShot
                    screen={item.screen}
                    alt={item.alt}
                    className="block h-auto w-full rounded-[8px] shadow-(--shadow-frame)"
                  />
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      <div className="hidden lg:block">
        <div
          className={`stage stage-${current.tone} overflow-hidden rounded-[18px] px-10 py-12 transition-[background-image] duration-500`}
        >
          {items.map((item, index) => (
            <figure
              key={item.id}
              hidden={index !== active}
              className="overflow-hidden rounded-[12px] bg-brand-raised shadow-(--shadow-frame)"
            >
              <AppShot
                screen={item.screen}
                alt={item.alt}
                className="block h-auto w-full"
              />
            </figure>
          ))}
        </div>
      </div>
    </div>
  );
}
