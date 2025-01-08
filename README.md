# Maxlew Videosystem 2.0

### Install OS and user

* Install Debian. Right now it is Debian 12.
* Create a user without password
* When finished, add user to sudoers
```code
$ su -
# nano /etc/sudoers
```
Edit the file:
```text
<user> ALL=(ALL:ALL) ALL
```
* Add script



### Install the videosystem

* Clone this repo into $HOME/maxlew_videosystem_node
* Run the help script `maxlew.sh -h`.


### Setup autostart

Copy the desktop-file to its location:  

```code
$ cp maxlew.desktop ~/.config/autostart/
``` 
Starta om systemet:

`$ sudo reboot now`
