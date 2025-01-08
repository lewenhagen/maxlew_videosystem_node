#!/usr/bin/env sh

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

UTILS=("curl" "nmap" "xdotool" "jq" "chromium-browser")

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
  list                Lists cameras in config
  add                 Add camera to config
  remove              Removes cameras from config
  scan                Scans network for cameras
  check               Checks if prerequisities are installed

  boot                Starts the application

"
}

check_prerequisities()
{
    local notInstalled=()
    for util in "${UTILS[@]}"
    do
      if ! command -v "$util" 2>&1 >/dev/null; then
          echo -e "$util is ${RED}not installed${NC}"
          # notInstalled+=("$util")
          sudo apt install -y $util
      else
        echo -e "$util ${GREEN}is installed${NC}"
      fi
    done

    
    if ! command -v "node" 2>&1 >/dev/null; then
      read -p "node is not installed. Should I help you with that? [y/N] " answer
      if [[ "$answer" = "y" ]]; then
        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash
        # nvm install --lts
        echo "restart terminal and run 'nvm install --lts'"
      else
        echo "Ok, I will not help with node installation."
      fi  
    else
      echo -e "node ${GREEN}is installed${NC}"
    fi
    
    [[ ${#notInstalled[@]} -eq 0 ]] && exit 0

    # read -p "Should I install the missing stuff? [y/N] " answer

    # if [[ "$answer" = "y" ]]; then
    #   for item in "${notInstalled[@]}"
    #   do
    #     sudo apt install -y $item       
    #   done
    # else
    #   echo "I will not install anything"
    # fi 

   


    # if ! command -v /sbin/ifconfig 2>&1 >/dev/null; then
    #       echo "ifconfig could not be found"
    # else
    #   echo "yay"
    # fi
    # type google-chrome >/dev/null 2>&1 || { echo >&2 "I require nmap but it's not installed.  Aborting."; exit 1; }
    # type /sbin/ifconfig >/dev/null 2>&1 || { echo >&2 "I require ifconfig but it's not installed. Install it by running 'apt install net-tools'.  Aborting."; exit 1; }
}


find_ip_cameras() {
  echo "Scanning the network for IP cameras..."
  read -p "Enter manufacturer: " manu
  nmap -r -sn 192.168.0.1/24 | grep "$manu" | awk '{print $6}'
}


boot()
{
    sleep 5
    #
    oldport=$(lsof -i :3000 | cut -d" " -f2 | tail -n1)

    if [ -z "$oldport" ]; then
        echo "No port in use..."
    else
        kill $oldport && echo "Old stuff killed."
    fi

    cd "$PATH_TO_EXEC" && npm start &

    sleep 3

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
 
    sleep 2

    xdotool key F11
}

addcamera () {
  local json_file="config/cameras.json"
  
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

            # install)
            #     install
            #     exit 0
            # ;;

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

            *)
                echo "Option/command not recognized."
                menu
                exit 1
            ;;
        esac
    done
}

main "$@"
