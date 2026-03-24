import logging
import sys

logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s %(levelname)-8s %(name)s  %(message)s",
    datefmt="%H:%M:%S",
    stream=sys.stdout,
)
