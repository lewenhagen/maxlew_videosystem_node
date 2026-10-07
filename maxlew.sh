#!/usr/bin/env bash
#
# Command line helper for the camera list (config/cameras.json).
# The same list can be edited in the app: press "m" in the main menu.
#
# After changing cameras here, restart the app so it reads them:
#   sudo systemctl restart videostream

VERSION="2.1"
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

# Work from the app folder, wherever the script is started from
cd "$(dirname "$(readlink -f "$0")")" || exit 1

CAMERAS_FILE="config/cameras.json"

version()
{
    printf "Version: %s\n" "$VERSION"
}

menu () {
  printf "
  Maxlew Videosystem %s
  ----------------------------------------------------------
  Command:            Description:
  ----------------------------------------------------------
  menu                Displays this menu
  list                Lists cameras in config
  add                 Add camera to config
  remove              Removes cameras from config
  scan                Scans network for cameras
  check               Checks if needed programs are installed

" "$VERSION"
}

check_prerequisities()
{
    [[ ! $(command -v curl) ]] && echo -e "curl is ${RED}not installed${NC}" || echo -e "curl${GREEN} is installed${NC}"
    [[ ! $(command -v jq) ]] && echo -e "jq is ${RED}not installed${NC}" || echo -e "jq${GREEN} is installed${NC}"
    [[ ! $(command -v nmap) ]] && echo -e "nmap is ${RED}not installed${NC}" || echo -e "nmap${GREEN} is installed${NC}"
    [[ ! $(command -v node) ]] && echo -e "node is ${RED}not installed${NC}" || echo -e "node${GREEN} is installed${NC}"
    [[ ! $(command -v chromium) ]] && echo -e "chromium is ${RED}not installed${NC}" || echo -e "chromium${GREEN} is installed${NC}"
}

find_ip_cameras() {
  echo "Scanning the network for IP cameras..."
  read -p "Enter manufacturer: " manu
  nmap -r -sn 192.168.0.1/24 | grep "$manu" | awk '{print $6}'
}

addcamera () {
  if [[ ! -f $CAMERAS_FILE ]]; then
    echo "File $CAMERAS_FILE does not exist. I will now create it..."
    echo "[]" > "$CAMERAS_FILE"
  fi

  read -p "Enter name: " name
  read -p "Enter IP address: " ip_address

  if [[ ! $ip_address =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
    echo "Invalid IP address format. Please try again."
    return 1
  fi

  jq --arg name "$name" --arg ip "$ip_address" \
    '. += [{name: $name, ip: $ip}]' "$CAMERAS_FILE" > tmp.json && mv tmp.json "$CAMERAS_FILE"

  echo "Added $name with ip adress $ip_address to $CAMERAS_FILE"
}

removecamera() {
  if [[ ! -f $CAMERAS_FILE ]]; then
    echo "File $CAMERAS_FILE does not exist. Nothing to remove."
    return 1
  fi

  list

  read -p "Enter the name of the camera to remove: " name

  jq --arg name "$name" 'del(.[] | select(.name == $name))' "$CAMERAS_FILE" > tmp.json && mv tmp.json "$CAMERAS_FILE"

  echo "Removed camera with name \"$name\" from $CAMERAS_FILE"
}

list() {
  jq .[] "$CAMERAS_FILE"
}

main()
{
    case "$1" in
        --help | -h | menu)
            menu
            exit 0
        ;;

        --version | -v)
            version
            exit 0
        ;;

        add)
          addcamera
          exit $?
        ;;

        remove)
          removecamera
          exit $?
        ;;

        list)
          list
          exit 0
        ;;

        scan)
          find_ip_cameras
          exit 0
        ;;

        check)
          check_prerequisities
          exit 0
        ;;

        *)
            echo "Option/command not recognized."
            menu
            exit 1
        ;;
    esac
}

main "$@"
