from importlib.metadata import version


def test_google_genai_uses_current_interactions_schema() -> None:
    major = int(version("google-genai").split(".", 1)[0])
    assert major >= 2
