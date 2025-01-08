#!/usr/bin/env bash

VERSION="2.0"
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

# Needed software
#
# google chrome
# wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
# sudo apt install ./google-chrome-stable_current_amd64.deb
#


# Installation:
# sudo apt install nmap net-tools xdotool xfce4-terminal 
# sudo apt install xdg-utils

# sudo apt install jq chromium-browser

PATH_TO_EXEC="$HOME/maxlew_videosystem"
PATH_TO_SYSTEM="$PATH_TO_EXEC/script"
# FILEPATH="$PATH_TO_SYSTEM/ips.txt"
# rm $FILEPATH

# UTILS=("curl" "nmap" "xdotool" "jq")

version()
{
    printf "Version: %s\n" "$VERSION"
}

menu () {
  printf "
  Maxlew Videosystem 2.0
  ----------------------------------------------------------
  Command:            Description:
  ----------------------------------------------------------
  menu                Displays this menu
  init                Creates the configfile
  list                Lists cameras in config
  add                 Add camera to config
  remove              Removes cameras from config
  scan                Scans network for cameras
  check               Checks if prerequisities are installed
  install             Tries to install missing prerequisities

  boot                Starts the application

"
}

check_prerequisities()
{
    [[ ! $(command -v curl) ]] && echo -e "Curl is ${RED}not installed${NC}" || echo -e "Curl${GREEN} is installed${NC}"
    [[ ! $(command -v jq) ]] && echo -e "jq is ${RED}not installed${NC}" || echo -e "jq${GREEN} is installed${NC}"
    [[ ! $(command -v nmap) ]] && echo -e "nmap is ${RED}not installed${NC}" || echo -e "nmap${GREEN} is installed${NC}"
    [[ ! $(command -v xdotool) ]] && echo -e "xdotool is ${RED}not installed${NC}" || echo -e "xdotool${GREEN} is installed${NC}"
    [[ ! $(command -v node) ]] && echo -e "node is ${RED}not installed${NC}" || echo -e "Node${GREEN} is installed${NC}"
    [[ ! $(command -v chromium) ]] && echo -e "Chromium is ${RED}not installed${NC}" || echo -e "Chromium${GREEN} is installed${NC}"
}

install() {
  [[ ! $(command -v curl) ]] && read -p "Press Enter to install Curl..." && sudo apt install -y curl
  [[ ! $(command -v jq) ]] && read -p "Press Enter to install jq..." && sudo apt install -y jq 
  [[ ! $(command -v nmap) ]] && read -p "Press Enter to install nmap..." && sudo apt install -y nmap
  [[ ! $(command -v xdotool) ]] && read -p "Press Enter to install xdotool..." && sudo apt install -y xdotool
  
  # Install node, npm
  [[ ! $(command -v node) ]] && read -p "Press Enter to install node..." && bash install_node.sh

  # Install Chromium Browswer on Debian. For Ubuntu it is "chromium-browswer"
  [[ ! $(command -v chromium) ]] && read -p "Press Enter to install Chromium..." && sudo apt install chromium
}


find_ip_cameras() {
  echo "Scanning the network for IP cameras..."
  read -p "Enter manufacturer: " manu
  nmap -r -sn 192.168.0.1/24 | grep "$manu" | awk '{print $6}'
}

kill() {
  echo "Killing running instance"
  kill -9 $(lsof -i :3000 | head -n 2 | tail -n 1 | cut -d" " -f5)
}


boot()
{
    export NVM_DIR="/home/$USER/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
    export NODE_ENV=development
    
    sleep 5
    #
    oldport=$(lsof -i :3000 | cut -d" " -f2 | tail -n1)

    if [ -z "$oldport" ]; then
        echo "No port in use..."
    else
        kill -9 $oldport && echo "Old stuff killed."
    fi

    cd "$PATH_TO_EXEC"
    npm start &

    sleep 5 # Det här pratade Per om...

    # --kiosk
    # google-chrome --no-first-run --disable-popup-blocking --disable-default-apps --disable-notifications --disable-extensions --disable-background-networking --app="google.se"
    # chromium-browser --no-first-run --disable-popup-blocking --disable-default-apps --disable-notifications --disable-extensions --disable-background-networking --app="google.se"
    # firefox --private-window "http://localhost:3000/splashscreen" &
    # firefox - edit policies.json in installation dir. Place this file in the distribution/ folder under Firefox's installation directory.

    # {
    #   "policies": {
    #     "DisableAppUpdate": true
    #   }
    # }
 
    # sleep 2

    xdotool key F11
}

addcamera () {
  local json_file="config/cameras.json"

  if [[ ! -f $json_file ]]; then
    echo "File $json_file does not exist. I will now create it..."
    touch "config/cameras.json"
    echo "File $json_file created. I will now continue."
  fi
  
  read -p "Enter name: " name
  read -p "Enter IP address: " ip_address

  if [[ ! $ip_address =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
    echo "Invalid IP address format. Please try again."
    return 1
  fi

  if [[ ! -f $json_file ]]; then
    echo "[]" > "$json_file"
  fi

  jq --arg name "$name" --arg ip "$ip_address" \
    '. += [{name: $name, ip: $ip}]' "$json_file" > tmp.json && mv tmp.json "$json_file"

  echo "Added $name with ip adress $ip_address to $json_file"
}

removecamera() {
  local json_file="config/cameras.json"

  list

  read -p "Enter the name of the camera to remove: " name

  if [[ ! -f $json_file ]]; then
    echo "File $json_file does not exist. Nothing to remove."
    return 1
  fi

  jq --arg name "$name" 'del(.[] | select(.name == $name))' "$json_file" > tmp.json && mv tmp.json "$json_file"

  echo "Removed camera with name \"$name\" from $json_file"
}


list() {
  jq .[] 'config/cameras.json'
}

init() {
   local json_file="config/cameras.json"
   local tarball="maxlewvideosystem-2.0.0.tgz"

   [[ ! -f $json_file ]] && echo "I will create the file: $json_file." && touch "config/cameras.json"
   
  

   [[ -f $tarball ]] && npm install ./$tarball 

}

main()
{
    while [ $(( $# )) ]
    do
        case "$1" in

            --help | -h | menu)
                menu
                exit 0
            ;;

            --version | -v)
                version
                exit 0
            ;;

            # map)
            #   run_nmap
            #   exit 0
            # ;;
           

            boot)
                boot
                exit 0
            ;;

            install)
                install
                exit 0
            ;;

            add)
              addcamera
              exit 0
            ;;

            remove)
              removecamera 
              exit 0
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

            init)
              init
              exit 0
            ;;

            kill)
              kill
              exit 0
            ;;

            *)
                echo "Option/command not recognized."
                menu
                exit 1
            ;;
        esac
    done
}

main "$@"
