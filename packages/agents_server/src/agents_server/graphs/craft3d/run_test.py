import asyncio
import logging

from agents_server.common.schemas import ObjectProps
from agents_server.graphs.craft3d.graph import craft3d_agent
from agents_server.graphs.craft3d.state import Craft3DState, get_current_artifact

async def main():
    logging.basicConfig(level=logging.DEBUG)
    log = logging.getLogger("graphs.craft3d")

    log.info("START testing")

    initial: Craft3DState = {
        "input": ObjectProps(
            object_name="Bakery",
            object_description=(
                "A quaint, steep-roofed cottage with a rustic bakery stall at the front. ..."
            ),
        ),
        "artifact_history": [],
        "current_version": None,
        "revise_count": 0,
        "job_id": "",
        "glb_url": "",
        "failure_reason": None,
    }

    final = await craft3d_agent.ainvoke(initial)

    log.info("END testing")
    log.info("job_id: %s", final.get("job_id"))
    log.info("glb_url: %s", final.get("glb_url"))
    log.info("failure_reason: %s", final.get("failure_reason"))

if __name__ == "__main__":
    asyncio.run(main())
