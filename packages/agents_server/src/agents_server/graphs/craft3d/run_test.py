import asyncio
import logging

from agents_server.graphs.craft3d import invoke_craft3d_agent
from agents_server.common.schemas import ObjectProps

async def main():
    logging.basicConfig(level=logging.DEBUG)
    log = logging.getLogger("graphs.craft3d")

    log.info("START testing")

    await invoke_craft3d_agent(ObjectProps(
        object_name="Bakery",
        object_description=(
            "A quaint, steep-roofed cottage with a rustic bakery stall at the front. ..."
        ),
    ))

    log.info("END testing")

if __name__ == "__main__":
    asyncio.run(main())