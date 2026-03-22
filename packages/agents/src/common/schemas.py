from pydantic import BaseModel, model_validator


class ObjectProps(BaseModel):
    object_name: str
    object_description: str = ""

    @model_validator(mode="before")
    @classmethod
    def _normalise_keys(cls, data: dict) -> dict:
        """Accept both {object_name, object_description} and {name, description}."""
        if isinstance(data, dict):
            if "name" in data and "object_name" not in data:
                data = {
                    "object_name": data["name"],
                    "object_description": data.get("description", ""),
                }
        return data
