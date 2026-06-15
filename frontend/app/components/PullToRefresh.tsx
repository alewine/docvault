"use client";

import { useEffect, useRef, useState } from "react";

const THRESHOLD = 65;
const MAX_TRAVEL = 80;
const INDICATOR_SIZE = 36;

interface Props {
  children: React.ReactNode;
}

export default function PullToRefresh({ children }: Props) {
  const [pullY, setPullY] = useState(0); // 0..MAX_TRAVEL
  const [releasing, setReleasing] = useState(false);
  const startYRef = useRef(0);
  const activeRef = useRef(false);

  useEffect(() => {
    if (!("ontouchstart" in window)) return;

    function onTouchStart(e: TouchEvent) {
      if (window.scrollY !== 0) return;
      startYRef.current = e.touches[0].clientY;
      activeRef.current = true;
    }

    function onTouchMove(e: TouchEvent) {
      if (!activeRef.current) return;
      const delta = e.touches[0].clientY - startYRef.current;
      if (delta <= 0) {
        // pulling up — cancel PTR
        activeRef.current = false;
        setPullY(0);
        return;
      }
      // Suppress native scroll while pulling down
      if (delta > 5) e.preventDefault();
      setPullY(Math.min(delta, MAX_TRAVEL));
    }

    function onTouchEnd() {
      if (!activeRef.current) return;
      activeRef.current = false;

      setPullY((current) => {
        if (current >= THRESHOLD) {
          setReleasing(true);
          setTimeout(() => window.location.reload(), 300);
          return current;
        }
        setReleasing(false);
        return 0;
      });

      if (pullY < THRESHOLD) {
        setPullY(0);
      }
    }

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Indicator sits at top-center; slides from -50px → visible based on pull
  const visible = pullY > 0 || releasing;
  const translateY = releasing
    ? INDICATOR_SIZE / 2 + 8
    : Math.max(0, (pullY / MAX_TRAVEL) * (INDICATOR_SIZE / 2 + 8));
  const ready = pullY >= THRESHOLD;

  return (
    <div className="relative">
      {visible && (
        <div
          aria-hidden
          style={{
            position: "fixed",
            top: 0,
            left: "50%",
            transform: `translateX(-50%) translateY(${translateY - INDICATOR_SIZE / 2}px)`,
            zIndex: 9999,
            width: INDICATOR_SIZE,
            height: INDICATOR_SIZE,
            borderRadius: "50%",
            background: "#1C1F26",
            border: "2px solid #00D4AA",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
            transition: releasing ? "none" : undefined,
          }}
        >
          {releasing ? (
            // Spinning loader
            <svg
              width="18"
              height="18"
              viewBox="0 0 18 18"
              fill="none"
              style={{ animation: "ptr-spin 0.7s linear infinite" }}
            >
              <circle
                cx="9"
                cy="9"
                r="7"
                stroke="#00D4AA"
                strokeWidth="2"
                strokeDasharray="36"
                strokeDashoffset="10"
                strokeLinecap="round"
              />
              <style>{`@keyframes ptr-spin { to { transform: rotate(360deg); } }`}</style>
            </svg>
          ) : (
            // Down-arrow icon — rotates when threshold met
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              style={{
                transition: "transform 0.2s ease",
                transform: ready ? "rotate(180deg)" : "rotate(0deg)",
              }}
            >
              <path
                d="M8 3v10M4 9l4 4 4-4"
                stroke="#00D4AA"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </div>
      )}
      {children}
    </div>
  );
}
