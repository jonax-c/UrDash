from __future__ import annotations

STYLE_PRESETS: dict[str, dict[str, str]] = {
    "auto": {"label": "AI decides", "description": "Choose the visual language from the request and device context.", "theme": ""},
    "minimal": {"label": "Minimal", "description": "Restrained typography, generous space, and essential controls.", "theme": "quiet"},
    "aurora": {"label": "Aurora", "description": "Luminous color, atmospheric depth, and refined motion.", "theme": "aurora"},
    "glassmorphism": {"label": "Glassmorphism", "description": "Translucent layers, subtle borders, and dimensional light.", "theme": "aurora"},
    "bento": {"label": "Bento", "description": "Clear modular hierarchy with varied scale and strong scanning.", "theme": "calm"},
    "editorial": {"label": "Editorial", "description": "Expressive type, asymmetric rhythm, and information-led composition.", "theme": "quiet"},
    "material": {"label": "Material", "description": "Familiar surfaces, clear elevation, and direct interaction states.", "theme": "calm"},
    "neobrutalist": {"label": "Neo-brutalist", "description": "Bold contrast, decisive outlines, and intentionally direct controls.", "theme": "sunrise"},
    "futuristic": {"label": "Futuristic", "description": "Technical precision, dark depth, telemetry, and controlled glow.", "theme": "graphite"},
    "organic": {"label": "Organic", "description": "Soft geometry, natural color, and calm spatial flow.", "theme": "calm"},
    "monochrome": {"label": "Monochrome", "description": "Tonal hierarchy, graphic contrast, and minimal color dependence.", "theme": "graphite"},
    "luxury": {"label": "Luxury", "description": "Quiet drama, polished detail, and premium restrained accents.", "theme": "graphite"},
    "playful": {"label": "Playful", "description": "Friendly color, expressive shapes, and lively purposeful motion.", "theme": "sunrise"},
}

STYLES = list(STYLE_PRESETS)


def resolve_style(style: str, fallback_theme: str) -> tuple[str, str]:
    """Resolve visual guidance and a compatible renderer theme."""
    preset = STYLE_PRESETS.get(style, STYLE_PRESETS["auto"])
    guidance = (
        "Choose the most appropriate visual language for this request."
        if style not in STYLE_PRESETS or style == "auto"
        else preset["description"]
    )
    return preset["theme"] or fallback_theme, guidance

